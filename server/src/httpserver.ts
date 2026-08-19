/**
 * The node:http request pipeline: read body (1 MB cap, strict UTF-8), match a
 * route, authenticate, run the handler, serialise the result. Every thrown
 * HttpError becomes `{"error": reason}` with its status; anything else is a
 * 500 that is also logged to stderr — nothing is swallowed.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { principalFromHeaders, principalFromToken, requireAgent, requireOperator, type Principal } from './auth';
import { MAX_BLOB_BYTES, MAX_BODY_BYTES, type Ctx } from './context';
import { HttpError, badRequest, notFound as notFoundError, payloadTooLarge, unauthorized } from './errors';
import { matchRoute, type Req, type Result, type Route } from './router';
import { decodeUtf8Strict } from './util';

export function createHttpServer(ctx: Ctx, routes: readonly Route[]): http.Server {
  const server = http.createServer((req, res) => {
    // CORS: browser-origin callers are legitimate clients (the Electron
    // renderer and ng-serve dev UI are cross-origin to this server, and
    // browser-extension agents may join later). Auth is bearer-token, never
    // cookie-based, so a permissive origin policy exposes nothing a caller
    // without a token could use.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Idempotency-Replayed');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }
    handle(ctx, routes, req, res).catch((err: unknown) => {
      respondError(res, err);
    });
  });
  return server;
}

async function handle(
  ctx: Ctx,
  routes: readonly Route[],
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://switchboard.invalid');
  } catch {
    respondJson(res, 400, { error: 'malformed request URL' });
    return;
  }

  // Blobs bypass the router deliberately: everything else in this API is JSON
  // in, JSON out, and the router's pipeline decodes bodies as strict UTF-8.
  // Attachment bytes are neither text nor small, so they get their own path
  // rather than a base64 detour through the JSON surface.
  if (url.pathname === '/v1/blobs' || url.pathname.startsWith('/v1/blobs/')) {
    await handleBlob(ctx, req, res, url);
    return;
  }

  const matched = matchRoute(routes, req.method ?? 'GET', url.pathname);
  if (matched === null) {
    respondJson(res, 404, { error: `no such endpoint: ${req.method} ${url.pathname}` });
    return;
  }
  if (matched === 'method-not-allowed') {
    respondJson(res, 405, { error: `method ${req.method} not allowed on ${url.pathname}` });
    return;
  }

  let bodyText = '';
  try {
    const raw = await readBody(req);
    bodyText = raw.length === 0 ? '' : decodeUtf8Strict(raw, 'request body');
  } catch (err) {
    respondError(res, err);
    return;
  }

  let principal: Principal;
  try {
    principal = matched.route.auth === 'none' ? { kind: 'none' } : principalFromHeaders(ctx, req.headers);
    if (matched.route.auth === 'operator') requireOperator(principal);
    if (matched.route.auth === 'agent') requireAgent(principal);
  } catch (err) {
    respondError(res, err);
    return;
  }

  // Presence is "last sign of life", and an authenticated request is a sign of
  // life. Stamping only on connect made a busy agent — one that posts every
  // few minutes over an old socket — read as hours stale in the console, which
  // is exactly when the operator is asking "is it working or asleep?". The
  // store throttles the write, so this costs nothing per request.
  if (principal.kind === 'agent') ctx.store.touchAgentSeen(principal.agent.id);

  const request: Req = {
    method: req.method ?? 'GET',
    path: url.pathname,
    params: matched.params,
    query: url.searchParams,
    headers: req.headers,
    bodyText,
    principal,
  };

  try {
    const result: Result = await matched.route.handler(ctx, request);
    if (result.contentType !== undefined && typeof result.body === 'string') {
      respondText(res, result.status, result.body, result.contentType, result.headers);
    } else {
      respondJson(res, result.status, result.body, result.headers);
    }
  } catch (err) {
    respondError(res, err);
  }
}

function readBody(req: http.IncomingMessage, cap: number = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    // Refuse an over-sized body before reading a byte when the client declared
    // its length; the streaming guard below covers chunked uploads.
    const declared = req.headers['content-length'];
    if (typeof declared === 'string' && /^\d+$/.test(declared) && Number(declared) > cap) {
      req.resume();
      reject(payloadTooLarge(`request body exceeds the ${cap} byte limit`));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > cap) {
        settled = true;
        req.destroy();
        reject(payloadTooLarge(`request body exceeds the ${cap} byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(badRequest(`request stream failed: ${err.message}`));
    });
  });
}

/**
 * `POST /v1/blobs` (upload) and `GET /v1/blobs/{id}` (download).
 *
 * Content-addressed: the id IS the sha256 of the bytes, so uploading the same
 * screenshot twice writes one file and returns the same id. The bytes live in
 * `<dataDir>/blobs/<id>` rather than in SQLite — a 4 MB row would bloat every
 * WAL checkpoint for something the database never queries.
 *
 * GET accepts `?token=` as well as the Authorization header, for the same
 * reason the WebSocket URLs do: an `<img src>` in the console cannot set a
 * header. The token is still a real credential — this is not public.
 */
async function handleBlob(
  ctx: Ctx,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  try {
    const headerToken = req.headers['authorization'];
    const queryToken = url.searchParams.get('token');
    const principal =
      typeof headerToken === 'string' && headerToken.length > 0
        ? principalFromHeaders(ctx, req.headers)
        : queryToken !== null && queryToken.length > 0
          ? principalFromToken(ctx, queryToken)
          : (() => {
              throw unauthorized('blobs require an agent or operator token');
            })();
    if (principal.kind === 'agent') ctx.store.touchAgentSeen(principal.agent.id);

    if (req.method === 'POST' && url.pathname === '/v1/blobs') {
      const mediaType = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]?.trim() || 'application/octet-stream';
      const nameRaw = url.searchParams.get('name');
      const name = nameRaw === null ? null : nameRaw.slice(0, 200);
      const bytes = await readBody(req, MAX_BLOB_BYTES);
      if (bytes.length === 0) throw badRequest('an attachment must have bytes');
      const id = createHash('sha256').update(bytes).digest('hex');
      const dir = path.join(ctx.config.dataDir, 'blobs');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, id);
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
      const row = ctx.store.putBlob(id, mediaType, bytes.length, name);
      respondJson(res, 201, row);
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/blobs/')) {
      const id = decodeURIComponent(url.pathname.slice('/v1/blobs/'.length));
      const row = ctx.store.getBlob(id);
      if (!row || !/^[0-9a-f]{64}$/.test(id)) throw notFoundError(`no such attachment '${id}'`);
      const file = path.join(ctx.config.dataDir, 'blobs', id);
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(file);
      } catch {
        throw notFoundError(`attachment '${id}' is recorded but its bytes are missing`);
      }
      if (res.writableEnded) return;
      res.writeHead(200, {
        'Content-Type': row.media_type,
        'Content-Length': String(bytes.length),
        // Content-addressed, so the bytes for an id can never change.
        'Cache-Control': 'private, max-age=31536000, immutable',
      });
      res.end(bytes);
      return;
    }

    respondJson(res, 405, { error: `method ${req.method} not allowed on ${url.pathname}` });
  } catch (err) {
    respondError(res, err);
  }
}

export function respondJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  if (res.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    ...(headers ?? {}),
  });
  res.end(payload);
}

/**
 * The one non-JSON response path (see Result.contentType): body written
 * verbatim as UTF-8. Errors never come through here — they are always JSON.
 */
export function respondText(
  res: http.ServerResponse,
  status: number,
  text: string,
  contentType: string,
  headers?: Record<string, string>,
): void {
  if (res.writableEnded) return;
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(payload.length),
    ...(headers ?? {}),
  });
  res.end(payload);
}

function respondError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    respondJson(res, err.status, { error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`switchboard: unhandled request error: ${message}\n`);
  if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
  respondJson(res, 500, { error: `internal server error: ${message}` });
}
