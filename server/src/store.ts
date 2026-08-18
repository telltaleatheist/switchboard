/**
 * Data access. Every SQL statement in the server lives here; routes deal in
 * plain objects. Sequence numbers (`channels.last_seq`, `agents.line_seq`) are
 * allocated inside transactions so they stay gapless.
 */

import type { Db } from './db';
import { conflict, notFound } from './errors';
import { nowIso } from './util';

export interface AgentRow {
  id: number;
  name: string;
  token_hash: string;
  created_at: string;
  line_seq: number;
}

export interface ChannelRow {
  id: number;
  name: string;
  status: 'open' | 'closed';
  created_at: string;
  closed_at: string | null;
  last_seq: number;
  note: string | null;
}

export interface MessageRow {
  id: number;
  channel_id: number;
  seq: number;
  ts: string;
  sender_id: number;
  to_json: string | null;
  subject: string;
  body: string;
  in_reply_to: number | null;
  signal: string | null;
  state: string | null;
}

/** A message as it appears on the wire (REST body and WS frame alike). */
export interface WireMessage {
  seq: number;
  ts: string;
  sender: string;
  to: string[] | null;
  subject: string;
  body: string;
  in_reply_to: number | null;
  signal: string | null;
  state: string | null;
}

export interface LineEventRow {
  id: number;
  agent_id: number;
  seq: number;
  ts: string;
  frame_json: string;
}

export interface PatchRequestRow {
  id: number;
  requester_id: number;
  with_json: string;
  purpose: string;
  status: string;
  created_at: string;
}

export interface ArchiveRow {
  id: number;
  channel_name: string;
  closed_at: string;
  reason: string;
  transcript: string;
}

export interface NewMessage {
  to: string[] | null;
  subject: string;
  body: string;
  in_reply_to: number | null;
  signal: string | null;
  state: string | null;
}

export class Store {
  public readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ---------------------------------------------------------------- agents

  createAgent(name: string, tokenHash: string): AgentRow {
    const existing = this.findAgentByName(name);
    if (existing) throw conflict(`agent '${name}' already exists`);
    const created_at = nowIso();
    const info = this.db
      .prepare('INSERT INTO agents(name, token_hash, created_at, line_seq) VALUES (?, ?, ?, 0)')
      .run(name, tokenHash, created_at);
    return {
      id: Number(info.lastInsertRowid),
      name,
      token_hash: tokenHash,
      created_at,
      line_seq: 0,
    };
  }

  setAgentTokenHash(agentId: number, tokenHash: string): void {
    this.db.prepare('UPDATE agents SET token_hash = ? WHERE id = ?').run(tokenHash, agentId);
  }

  findAgentByName(name: string): AgentRow | undefined {
    return this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as AgentRow | undefined;
  }

  findAgentByTokenHash(tokenHash: string): AgentRow | undefined {
    return this.db.prepare('SELECT * FROM agents WHERE token_hash = ?').get(tokenHash) as AgentRow | undefined;
  }

  getAgentById(id: number): AgentRow {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
    if (!row) throw notFound(`agent id ${id} no longer exists`);
    return row;
  }

  listAgents(): AgentRow[] {
    return this.db.prepare('SELECT * FROM agents ORDER BY name').all() as AgentRow[];
  }

  requireAgentByName(name: string): AgentRow {
    const row = this.findAgentByName(name);
    if (!row) throw notFound(`unknown agent '${name}'`);
    return row;
  }

  // -------------------------------------------------------------- channels

  /** Open channel of this name, if any. */
  findOpenChannel(name: string): ChannelRow | undefined {
    return this.db.prepare("SELECT * FROM channels WHERE name = ? AND status = 'open'").get(name) as
      | ChannelRow
      | undefined;
  }

  /**
   * Resolve a channel by name: the open one wins; otherwise the most recently
   * closed channel that carried the name (so history and archives stay
   * addressable after a close).
   */
  resolveChannel(name: string): ChannelRow | undefined {
    const open = this.findOpenChannel(name);
    if (open) return open;
    return this.db
      .prepare("SELECT * FROM channels WHERE name = ? AND status = 'closed' ORDER BY closed_at DESC, id DESC LIMIT 1")
      .get(name) as ChannelRow | undefined;
  }

  getChannelById(id: number): ChannelRow {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined;
    if (!row) throw notFound(`channel id ${id} no longer exists`);
    return row;
  }

  listChannels(status: 'open' | 'closed' | null): ChannelRow[] {
    if (status === null) {
      return this.db.prepare('SELECT * FROM channels ORDER BY id DESC').all() as ChannelRow[];
    }
    return this.db.prepare('SELECT * FROM channels WHERE status = ? ORDER BY id DESC').all(status) as ChannelRow[];
  }

  createChannel(name: string, note: string | null, memberIds: number[]): ChannelRow {
    const create = this.db.transaction((): ChannelRow => {
      if (this.findOpenChannel(name)) throw conflict(`an open channel named '${name}' already exists`);
      const created_at = nowIso();
      const info = this.db
        .prepare("INSERT INTO channels(name, status, created_at, closed_at, last_seq, note) VALUES (?, 'open', ?, NULL, 0, ?)")
        .run(name, created_at, note);
      const channelId = Number(info.lastInsertRowid);
      const insertMember = this.db.prepare(
        'INSERT INTO channel_members(channel_id, agent_id, joined_at) VALUES (?, ?, ?)',
      );
      for (const agentId of memberIds) insertMember.run(channelId, agentId, created_at);
      return {
        id: channelId,
        name,
        status: 'open',
        created_at,
        closed_at: null,
        last_seq: 0,
        note,
      };
    });
    return create();
  }

  markChannelClosed(channelId: number, closedAt: string): void {
    this.db.prepare("UPDATE channels SET status = 'closed', closed_at = ? WHERE id = ?").run(closedAt, channelId);
  }

  memberNames(channelId: number): string[] {
    const rows = this.db
      .prepare(
        'SELECT a.name AS name FROM channel_members m JOIN agents a ON a.id = m.agent_id WHERE m.channel_id = ? ORDER BY a.name',
      )
      .all(channelId) as { name: string }[];
    return rows.map((r) => r.name);
  }

  memberIds(channelId: number): number[] {
    const rows = this.db
      .prepare('SELECT agent_id FROM channel_members WHERE channel_id = ? ORDER BY agent_id')
      .all(channelId) as { agent_id: number }[];
    return rows.map((r) => r.agent_id);
  }

  isMember(channelId: number, agentId: number): boolean {
    const row = this.db
      .prepare('SELECT 1 AS ok FROM channel_members WHERE channel_id = ? AND agent_id = ?')
      .get(channelId, agentId) as { ok: number } | undefined;
    return row !== undefined;
  }

  /** Open channels an agent belongs to. */
  openChannelsForAgent(agentId: number): ChannelRow[] {
    return this.db
      .prepare(
        "SELECT c.* FROM channels c JOIN channel_members m ON m.channel_id = c.id WHERE m.agent_id = ? AND c.status = 'open' ORDER BY c.id",
      )
      .all(agentId) as ChannelRow[];
  }

  channelNamesForAgent(agentId: number): string[] {
    return this.openChannelsForAgent(agentId).map((c) => c.name);
  }

  // -------------------------------------------------------------- messages

  /**
   * Append a message, allocating the next gapless per-channel seq. When an
   * idempotency key is supplied the stored result is written in the same
   * transaction, so a retry can never append twice.
   */
  appendMessage(
    channel: ChannelRow,
    senderId: number,
    msg: NewMessage,
    idempotencyKey: string | null,
  ): { seq: number; ts: string } {
    const append = this.db.transaction((): { seq: number; ts: string } => {
      const current = this.db.prepare('SELECT last_seq FROM channels WHERE id = ?').get(channel.id) as
        | { last_seq: number }
        | undefined;
      if (!current) throw notFound(`channel '${channel.name}' no longer exists`);
      const seq = current.last_seq + 1;
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO messages(channel_id, seq, ts, sender_id, to_json, subject, body, in_reply_to, signal, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          channel.id,
          seq,
          ts,
          senderId,
          msg.to === null ? null : JSON.stringify(msg.to),
          msg.subject,
          msg.body,
          msg.in_reply_to,
          msg.signal,
          msg.state,
        );
      this.db.prepare('UPDATE channels SET last_seq = ? WHERE id = ?').run(seq, channel.id);
      if (idempotencyKey !== null) {
        this.db
          .prepare('INSERT INTO idempotency(key, agent_id, result_json, created_at) VALUES (?, ?, ?, ?)')
          .run(idempotencyKey, senderId, JSON.stringify({ seq, ts }), ts);
      }
      return { seq, ts };
    });
    return append();
  }

  findIdempotentResult(key: string, agentId: number): { seq: number; ts: string } | undefined {
    const row = this.db.prepare('SELECT result_json FROM idempotency WHERE key = ? AND agent_id = ?').get(key, agentId) as
      | { result_json: string }
      | undefined;
    if (!row) return undefined;
    return JSON.parse(row.result_json) as { seq: number; ts: string };
  }

  messagesSince(channelId: number, since: number): WireMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, a.name AS sender_name FROM messages m JOIN agents a ON a.id = m.sender_id
         WHERE m.channel_id = ? AND m.seq > ? ORDER BY m.seq`,
      )
      .all(channelId, since) as (MessageRow & { sender_name: string })[];
    return rows.map(toWireMessage);
  }

  seqExists(channelId: number, seq: number): boolean {
    const row = this.db.prepare('SELECT 1 AS ok FROM messages WHERE channel_id = ? AND seq = ?').get(channelId, seq) as
      | { ok: number }
      | undefined;
    return row !== undefined;
  }

  lastMessageTs(channelId: number): string | null {
    const row = this.db.prepare('SELECT ts FROM messages WHERE channel_id = ? ORDER BY seq DESC LIMIT 1').get(channelId) as
      | { ts: string }
      | undefined;
    return row ? row.ts : null;
  }

  // ----------------------------------------------------------- line events

  /** Append a control-line event, allocating the next gapless per-agent seq. */
  appendLineEvent(agentId: number, frame: Record<string, unknown>): { seq: number; ts: string; frame: Record<string, unknown> } {
    const append = this.db.transaction(() => {
      const row = this.db.prepare('SELECT line_seq FROM agents WHERE id = ?').get(agentId) as
        | { line_seq: number }
        | undefined;
      if (!row) throw notFound(`agent id ${agentId} no longer exists`);
      const seq = row.line_seq + 1;
      const ts = nowIso();
      const full = { ...frame, line_seq: seq };
      this.db
        .prepare('INSERT INTO line_events(agent_id, seq, ts, frame_json) VALUES (?, ?, ?, ?)')
        .run(agentId, seq, ts, JSON.stringify(full));
      this.db.prepare('UPDATE agents SET line_seq = ? WHERE id = ?').run(seq, agentId);
      return { seq, ts, frame: full };
    });
    return append();
  }

  lineEventsSince(agentId: number, since: number): Record<string, unknown>[] {
    const rows = this.db
      .prepare('SELECT frame_json FROM line_events WHERE agent_id = ? AND seq > ? ORDER BY seq')
      .all(agentId, since) as { frame_json: string }[];
    return rows.map((r) => JSON.parse(r.frame_json) as Record<string, unknown>);
  }

  // -------------------------------------------------------- patch requests

  createPatchRequest(requesterId: number, withNames: string[], purpose: string): PatchRequestRow {
    const created_at = nowIso();
    const info = this.db
      .prepare("INSERT INTO patch_requests(requester_id, with_json, purpose, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .run(requesterId, JSON.stringify(withNames), purpose, created_at);
    return {
      id: Number(info.lastInsertRowid),
      requester_id: requesterId,
      with_json: JSON.stringify(withNames),
      purpose,
      status: 'pending',
      created_at,
    };
  }

  getPatchRequest(id: number): PatchRequestRow | undefined {
    return this.db.prepare('SELECT * FROM patch_requests WHERE id = ?').get(id) as PatchRequestRow | undefined;
  }

  listPatchRequests(status: string | null): PatchRequestRow[] {
    if (status === null) return this.db.prepare('SELECT * FROM patch_requests ORDER BY id DESC').all() as PatchRequestRow[];
    return this.db.prepare('SELECT * FROM patch_requests WHERE status = ? ORDER BY id DESC').all(status) as PatchRequestRow[];
  }

  setPatchRequestStatus(id: number, status: string): void {
    this.db.prepare('UPDATE patch_requests SET status = ? WHERE id = ?').run(status, id);
  }

  // -------------------------------------------------------------- archives

  insertArchive(channelName: string, closedAt: string, reason: string, transcript: string): number {
    const info = this.db
      .prepare('INSERT INTO archives(channel_name, closed_at, reason, transcript) VALUES (?, ?, ?, ?)')
      .run(channelName, closedAt, reason, transcript);
    return Number(info.lastInsertRowid);
  }

  listArchives(): Omit<ArchiveRow, 'transcript'>[] {
    return this.db
      .prepare('SELECT id, channel_name, closed_at, reason FROM archives ORDER BY id DESC')
      .all() as Omit<ArchiveRow, 'transcript'>[];
  }

  getArchive(id: number): ArchiveRow | undefined {
    return this.db.prepare('SELECT * FROM archives WHERE id = ?').get(id) as ArchiveRow | undefined;
  }
}

export function toWireMessage(row: MessageRow & { sender_name: string }): WireMessage {
  return {
    seq: row.seq,
    ts: row.ts,
    sender: row.sender_name,
    to: row.to_json === null ? null : (JSON.parse(row.to_json) as string[]),
    subject: row.subject,
    body: row.body,
    in_reply_to: row.in_reply_to,
    signal: row.signal,
    state: row.state,
  };
}
