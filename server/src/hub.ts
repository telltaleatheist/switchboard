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

export class Hub {
  private readonly channelConns = new Set<ChannelConnection>();
  private readonly lineConns = new Set<LineConnection>();
  private readonly waiters = new Map<number, Set<Waiter>>();

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

  /** True when the agent holds at least one open socket (line or channel). */
  isAgentConnected(agentId: number): boolean {
    for (const c of this.lineConns) if (c.agentId === agentId) return true;
    for (const c of this.channelConns) if (c.agentId === agentId) return true;
    return false;
  }

  /** Should this recipient be woken by a message with this `to` list? */
  static addressedTo(to: string[] | null, agentName: string | null): boolean {
    if (agentName === null) return true; // operator: unfiltered
    if (to === null) return true; // everyone
    return to.includes(agentName);
  }

  /** Fan a new message out to the channel's sockets, push-filtered. */
  broadcastMessage(channelId: number, channelName: string, message: WireMessage): void {
    const frame = JSON.stringify({ type: 'message', channel: channelName, message });
    for (const conn of this.channelConns) {
      if (conn.channelId !== channelId) continue;
      if (!Hub.addressedTo(message.to, conn.agentName)) continue;
      send(conn.socket, frame);
    }
    this.releaseWaiters(channelId);
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
  }

  // ------------------------------------------------------------ long-poll

  /**
   * Resolve when the channel gets news, or after timeoutMs. Returns true when
   * woken by news, false on timeout.
   */
  waitForChannelNews(channelId: number, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let set = this.waiters.get(channelId);
      if (!set) {
        set = new Set<Waiter>();
        this.waiters.set(channelId, set);
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

  private releaseWaiters(channelId: number): void {
    const set = this.waiters.get(channelId);
    if (!set) return;
    this.waiters.delete(channelId);
    for (const waiter of set) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
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
