/**
 * WebSocket surface: `/v1/channels/{name}/ws` and `/v1/agents/me/line`.
 *
 * Both are replay-then-live: on connect, everything with seq > `since` is
 * flushed (push-filtered for channel members), then live frames stream. There
 * is no hello frame — an idle connect must wake nobody (SPEC §7).
 */

import type * as http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { principalFromToken } from './auth';
import type { Ctx } from './context';
import { HttpError, badRequest, forbidden, notFound, unauthorized } from './errors';
import { Hub, injectToken, type ChannelConnection, type LineConnection } from './hub';
import { queryInt } from './util';

const PING_INTERVAL_MS = 30_000;

export interface WsAttachment {
  wss: WebSocketServer;
  stop: () => void;
}

export function attachWebSockets(ctx: Ctx, server: http.Server): WsAttachment {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      route(ctx, wss, req, socket, head);
    } catch (err) {
      rejectUpgrade(socket, err);
    }
  });

  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', (socket: WebSocket) => {
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
  });

  const pinger = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, PING_INTERVAL_MS);
  pinger.unref();

  return {
    wss,
    stop: () => {
      clearInterval(pinger);
      wss.close();
    },
  };
}

function route(ctx: Ctx, wss: WebSocketServer, req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', 'http://switchboard.invalid');
  const params = url.searchParams;

  const token = params.get('token');
  if (token === null || token.length === 0) throw unauthorized("WebSocket URLs require a 'token' query parameter");
  const principal = principalFromToken(ctx, token);

  const since = queryInt(params, 'since', 0);

  const channelMatch = /^\/v1\/channels\/([^/]+)\/ws$/.exec(url.pathname);
  if (channelMatch) {
    for (const key of params.keys()) {
      if (!['token', 'since'].includes(key)) throw badRequest(`unknown query parameter '${key}'`);
    }
    const name = decodeURIComponent(channelMatch[1] as string);
    const channel = ctx.store.resolveChannel(name);
    if (!channel) throw notFound(`unknown channel '${name}'`);
    if (channel.status !== 'open') throw new HttpError(409, `channel '${name}' is closed`);

    let agentId: number | null = null;
    let agentName: string | null = null;
    if (principal.kind === 'agent') {
      if (!ctx.store.isMember(channel.id, principal.agent.id)) {
        throw forbidden(`agent '${principal.agent.name}' is not a member of channel '${name}'`);
      }
      agentId = principal.agent.id;
      agentName = principal.agent.name;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      // Replay first, then register: no await in between, so no live frame can
      // slip past and nothing is delivered twice.
      const backlog = ctx.store
        .messagesSince(channel.id, since)
        .filter((m) => Hub.addressedTo(m.to, agentName));
      // Agents are never pushed wake:false records, replay included — a
      // reconnect must not turn the log into wake-ups. Explicit plain
      // pulls (and operator sockets) are where the record lives.
      const visible = agentName === null ? backlog : backlog.filter((m) => m.wake !== false);
      // Digests ride along only if the replay is waking this agent anyway. A
      // reconnect whose backlog is nothing but digests must stay silent —
      // otherwise "delivered without waking" becomes "woken by re-arming",
      // which is the cost the mode exists to avoid. Held ones stay owed:
      // digestFloor keeps them queued for the next waking frame.
      const wakes = visible.some((m) => m.wake === true);
      const replay = agentName !== null && !wakes ? [] : visible;
      for (const message of replay) {
        ws.send(JSON.stringify({ type: 'message', channel: channel.name, message }));
      }
      const digestFloor = replay.length > 0 ? (replay[replay.length - 1] as { seq: number }).seq : since;
      const conn: ChannelConnection = {
        socket: ws,
        channelId: channel.id,
        channelName: channel.name,
        agentId,
        agentName,
        digestFloor,
      };
      ctx.hub.addChannelConnection(conn);
      ws.on('close', () => ctx.hub.removeChannelConnection(conn));
      ws.on('error', () => ctx.hub.removeChannelConnection(conn));
      ws.on('message', () => ws.close(1003, 'switchboard sockets are receive-only'));
    });
    return;
  }

  if (url.pathname === '/v1/agents/me/line') {
    for (const key of params.keys()) {
      if (!['token', 'since'].includes(key)) throw badRequest(`unknown query parameter '${key}'`);
    }
    if (principal.kind !== 'agent') throw forbidden('the control line requires an agent token');
    const agentId = principal.agent.id;

    ctx.store.touchAgentSeen(agentId);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      const conn: LineConnection = { socket: ws, agentId, token: principal.token };
      // Deliberately NO welcome frame here, though it was asked for: a hello
      // on connect would wake every agent on every re-arm, which is the one
      // thing the socket must never do (SPEC §7, and the header above). The
      // welcome rides on /v1/agents/me instead, which the skill now requires
      // on every recovery — same delivery, no wake-up.
      for (const frame of ctx.store.lineEventsSince(agentId, since)) {
        ws.send(JSON.stringify(injectToken(frame, principal.token)));
      }
      ctx.hub.addLineConnection(conn);
      ws.on('close', () => ctx.hub.removeLineConnection(conn));
      ws.on('error', () => ctx.hub.removeLineConnection(conn));
      ws.on('message', () => ws.close(1003, 'switchboard sockets are receive-only'));
    });
    return;
  }

  throw notFound(`no such WebSocket endpoint: ${url.pathname}`);
}

/** Reject an upgrade with a real HTTP status + JSON body, then hang up. */
function rejectUpgrade(socket: Duplex, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof HttpError)) {
    process.stderr.write(`switchboard: unhandled upgrade error: ${message}\n`);
  }
  const body = Buffer.from(JSON.stringify({ error: message }), 'utf8');
  const head = [
    `HTTP/1.1 ${status} ${statusText(status)}`,
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${body.length}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  socket.end(head + body.toString('utf8'));
}

function statusText(status: number): string {
  switch (status) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    case 409:
      return 'Conflict';
    default:
      return 'Internal Server Error';
  }
}
