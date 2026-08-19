/**
 * The live-connection hub: every open WebSocket, plus the long-poll waiters.
 *
 * Push filtering happens HERE and only here — a channel member's socket sees a
 * message frame only when `to` is null or names it (SPEC §7). Operator sockets
 * are not members and receive every frame unfiltered (ARCHITECTURE, ui/ note).
 */

import type { WebSocket } from 'ws';
import type { WireMessage } from './store';

export interface ChannelConnection {
  socket: WebSocket;
  channelId: number;
  channelName: string;
  /** null for an operator connection (unfiltered). */
  agentId: number | null;
  agentName: string | null;
  /**
   * Highest seq this connection has been brought up to date on for DIGEST
   * messages. Digests above it are owed and will ride along with the next
   * waking frame (see broadcastMessage). Connection-local on purpose: the
   * server keeps no per-agent read state, and this is delivery bookkeeping
   * for one socket, not a cursor.
   */
  digestFloor: number;
}

export interface LineConnection {
  socket: WebSocket;
  agentId: number;
  /** The plaintext token this connection authenticated with; see injectToken. */
  token: string;
}

interface Waiter {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

/**
 * How recently an agent must have long-polled its control line to count as
 * connected. Watcher loops re-request at most ~61s apart (wait=60 plus one
 * round trip), so 90s covers a healthy loop with margin without letting a
 * dead one linger long.
 */
const LINE_POLL_LIVENESS_MS = 90_000;

export class Hub {
  private readonly channelConns = new Set<ChannelConnection>();
  private readonly lineConns = new Set<LineConnection>();
  private readonly waiters = new Map<number, Set<Waiter>>();
  /** Long-poll waiters on control lines, keyed by agent id (see waitForLineNews). */
  private readonly lineWaiters = new Map<number, Set<Waiter>>();
  /** Last control-line long-poll per agent id — the HTTP watcher's heartbeat. */
  private readonly lastLinePoll = new Map<number, number>();

  addChannelConnection(conn: ChannelConnection): void {
    this.channelConns.add(conn);
  }

  removeChannelConnection(conn: ChannelConnection): void {
    this.channelConns.delete(conn);
  }

  addLineConnection(conn: LineConnection): void {
    this.lineConns.add(conn);
  }

  removeLineConnection(conn: LineConnection): void {
    this.lineConns.delete(conn);
  }

  /** Stamp a control-line long-poll (called by GET /v1/agents/me/line). */
  markLinePoll(agentId: number): void {
    this.lastLinePoll.set(agentId, Date.now());
  }

  /**
   * True when the agent has a live receive path: an open socket (line or
   * channel), or a control-line long-poll within the liveness window —
   * HTTP watchers are just as connected as WS ones, they only look
   * different from here.
   */
  isAgentConnected(agentId: number): boolean {
    for (const c of this.lineConns) if (c.agentId === agentId) return true;
    for (const c of this.channelConns) if (c.agentId === agentId) return true;
    const last = this.lastLinePoll.get(agentId);
    return last !== undefined && Date.now() - last < LINE_POLL_LIVENESS_MS;
  }

  /**
   * What this agent is actually subscribed to, right now, as the server sees
   * it — open sockets per channel, open control lines, and the last
   * control-line long-poll. Agents cannot otherwise tell whether their
   * Monitors died in a compaction or whether they accidentally armed the same
   * channel twice; both failure modes are one request away from obvious here.
   */
  subscriptionsFor(agentId: number): {
    line_sockets: number;
    last_line_poll_at: string | null;
    channels: { channel: string; sockets: number }[];
  } {
    let lineSockets = 0;
    for (const c of this.lineConns) if (c.agentId === agentId) lineSockets += 1;
    const perChannel = new Map<string, number>();
    for (const c of this.channelConns) {
      if (c.agentId !== agentId) continue;
      perChannel.set(c.channelName, (perChannel.get(c.channelName) ?? 0) + 1);
    }
    const lastPoll = this.lastLinePoll.get(agentId);
    return {
      line_sockets: lineSockets,
      last_line_poll_at: lastPoll === undefined ? null : new Date(lastPoll).toISOString(),
      channels: [...perChannel.entries()]
        .map(([channel, sockets]) => ({ channel, sockets }))
        .sort((a, b) => a.channel.localeCompare(b.channel)),
    };
  }

  /** Should this recipient be woken by a message with this `to` list? */
  static addressedTo(to: string[] | null, agentName: string | null): boolean {
    if (agentName === null) return true; // operator: unfiltered
    if (to === null) return true; // everyone
    return to.includes(agentName);
  }

  /**
   * Fan a new message out to the channel's sockets, push-filtered. The sender's
   * own sockets are skipped: their POST already confirmed the append with
   * {seq,ts}, so echoing the message back would cost them a model turn for
   * nothing. Live push only — WS replay and history reads still include the
   * sender's own messages, because catch-up after a restart or compaction may
   * genuinely need them back. Operator sockets (agentName null) are unfiltered.
   *
   * The sender is matched by agent ID, never by name: a rename must never race
   * echo suppression (ARCHITECTURE "Rename safety").
   */
  /**
   * Fan-out, three wake modes deep.
   *
   * - `wake: true` — pushed now to every addressee (minus the sender).
   * - `wake: false` — record-only: pushed to no agent, ever.
   * - `wake: "digest"` — HELD for agents: not pushed on its own, but flushed
   *   ahead of the next waking frame that same connection receives. Nothing on
   *   the record stays invisible, and nobody is interrupted for it.
   *
   * `held` reads the channel's messages after a seq — supplied by the caller,
   * which owns the store. It is only consulted when there is a waking frame to
   * attach digests to, so a quiet channel does no work.
   *
   * Operator sockets (agentName null) are unfiltered and see all three
   * immediately: a human reading costs no model turns.
   */
  broadcastMessage(
    channelId: number,
    channelName: string,
    senderId: number,
    message: WireMessage,
    held?: (afterSeq: number) => WireMessage[],
  ): void {
    const frame = JSON.stringify({ type: 'message', channel: channelName, message });
    for (const conn of this.channelConns) {
      if (conn.channelId !== channelId) continue;
      if (conn.agentId !== null && conn.agentId === senderId) continue;
      const isAgent = conn.agentName !== null;
      if (message.wake === false && isAgent) continue;
      if (!Hub.addressedTo(message.to, conn.agentName)) continue;
      if (message.wake === 'digest' && isAgent) continue; // held, not dropped

      if (isAgent && held) {
        for (const pending of held(conn.digestFloor)) {
          if (pending.seq >= message.seq) break;
          if (pending.wake !== 'digest') continue;
          if (!Hub.addressedTo(pending.to, conn.agentName)) continue;
          send(conn.socket, JSON.stringify({ type: 'message', channel: channelName, message: pending }));
        }
      }
      if (isAgent) conn.digestFloor = message.seq;
      send(conn.socket, frame);
    }
    this.releaseWaiters(channelId);
  }

  /**
   * Point every live channel connection this agent holds at its new name, so
   * `to:` push filtering is correct from the very next frame — no reconnect
   * required (ARCHITECTURE "Rename safety").
   */
  renameAgent(agentId: number, name: string): void {
    for (const conn of this.channelConns) {
      if (conn.agentId === agentId) conn.agentName = name;
    }
  }

  /**
   * Deliver a persisted control-line frame to the agent's open line sockets.
   * `injectToken` rewrites the `token` field of invite frames with the token
   * the receiving connection authenticated with — the stored frame never holds
   * a plaintext token (see ARCHITECTURE "Channel invite tokens").
   */
  pushLineFrame(agentId: number, frame: Record<string, unknown>): void {
    for (const conn of this.lineConns) {
      if (conn.agentId !== agentId) continue;
      send(conn.socket, JSON.stringify(injectToken(frame, conn.token)));
    }
    releaseWaiterSet(this.lineWaiters, agentId);
  }

  /** Close every socket attached to a channel (used when the channel closes). */
  closeChannelSockets(channelId: number, code: number, reason: string): void {
    for (const conn of [...this.channelConns]) {
      if (conn.channelId !== channelId) continue;
      try {
        conn.socket.close(code, reason);
      } catch {
        conn.socket.terminate();
      }
      this.channelConns.delete(conn);
    }
    this.releaseWaiters(channelId);
  }

  /** Close one agent's sockets on ONE channel (used when it is unpatched). */
  closeAgentChannelSockets(agentId: number, channelId: number, reason: string): void {
    for (const conn of [...this.channelConns]) {
      if (conn.agentId !== agentId || conn.channelId !== channelId) continue;
      try {
        conn.socket.close(1000, reason);
      } catch {
        conn.socket.terminate();
      }
      this.channelConns.delete(conn);
    }
  }

  /** Close every socket a (just-deleted) agent holds — line and channel. */
  closeAgentSockets(agentId: number, reason: string): void {
    this.lastLinePoll.delete(agentId);
    for (const conn of [...this.lineConns]) {
      if (conn.agentId !== agentId) continue;
      try {
        conn.socket.close(1000, reason);
      } catch {
        conn.socket.terminate();
      }
      this.lineConns.delete(conn);
    }
    for (const conn of [...this.channelConns]) {
      if (conn.agentId !== agentId) continue;
      try {
        conn.socket.close(1000, reason);
      } catch {
        conn.socket.terminate();
      }
      this.channelConns.delete(conn);
    }
  }

  /** Broadcast the shutdown frame on every open socket and close them (1001). */
  broadcastShutdown(): void {
    const frame = JSON.stringify({ type: 'shutdown' });
    for (const conn of [...this.channelConns]) {
      send(conn.socket, frame);
      closeSoon(conn.socket);
    }
    for (const conn of [...this.lineConns]) {
      send(conn.socket, frame);
      closeSoon(conn.socket);
    }
    this.channelConns.clear();
    this.lineConns.clear();
    for (const channelId of [...this.waiters.keys()]) this.releaseWaiters(channelId);
    for (const agentId of [...this.lineWaiters.keys()]) releaseWaiterSet(this.lineWaiters, agentId);
  }

  // ------------------------------------------------------------ long-poll

  /**
   * Resolve when the channel gets news, or after timeoutMs. Returns true when
   * woken by news, false on timeout.
   */
  waitForChannelNews(channelId: number, timeoutMs: number): Promise<boolean> {
    return addWaiter(this.waiters, channelId, timeoutMs);
  }

  /**
   * Resolve when the agent's control line gets a new persisted frame, or
   * after timeoutMs — the long-poll half of `GET /v1/agents/me/line`, for
   * clients whose harness can't open a WebSocket to this host (the Monitor
   * tool refuses private-range addresses; only loopback is allowed).
   */
  waitForLineNews(agentId: number, timeoutMs: number): Promise<boolean> {
    return addWaiter(this.lineWaiters, agentId, timeoutMs);
  }

  private releaseWaiters(channelId: number): void {
    releaseWaiterSet(this.waiters, channelId);
  }
}

function addWaiter(map: Map<number, Set<Waiter>>, key: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let set = map.get(key);
    if (!set) {
      set = new Set<Waiter>();
      map.set(key, set);
    }
    const waiter: Waiter = {
      resolve: () => resolve(true),
      timer: setTimeout(() => {
        set?.delete(waiter);
        resolve(false);
      }, timeoutMs),
    };
    waiter.timer.unref();
    set.add(waiter);
  });
}

function releaseWaiterSet(map: Map<number, Set<Waiter>>, key: number): void {
  const set = map.get(key);
  if (!set) return;
  map.delete(key);
  for (const waiter of set) {
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
}

export function injectToken(frame: Record<string, unknown>, token: string): Record<string, unknown> {
  if (frame['type'] !== 'invite') return frame;
  return { ...frame, token };
}

function send(socket: WebSocket, data: string): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(data, (err) => {
    if (err) process.stderr.write(`switchboard: ws send failed: ${err.message}\n`);
  });
}

function closeSoon(socket: WebSocket): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.close(1001, 'server-shutdown');
}
