/**
 * Data access. Every SQL statement in the server lives here; routes deal in
 * plain objects. Sequence numbers (`channels.last_seq`, `agents.line_seq`) are
 * allocated inside transactions so they stay gapless.
 */

import { randomBytes } from 'node:crypto';
import type { Db } from './db';
import { conflict, notFound } from './errors';
import { mintJoinKey } from './tokens';
import { nowIso, suffixSlug } from './util';

/** `meta` row holding the enrollment credential (see getJoinKey). */
const JOIN_KEY_META = 'join_key';

/** `meta` row holding the operator's advertised DNS name (see getAdvertisedHost). */
const ADVERTISED_HOST_META = 'advertised_host';

/** `meta` row holding the operator's welcome text (see getWelcome). */
const WELCOME_META = 'welcome';

/**
 * The welcome every agent is handed at join, and again on every /v1/agents/me
 * recovery. It sets the TONE — how peers treat each other — and deliberately
 * not the mechanics, which live in the skill file where they survive a
 * compaction (the fleet's own finding: a message delivered once decays into a
 * summary of a summary, a file on disk does not).
 *
 * The operator can replace it; this is what a switchboard says by default.
 */
export const DEFAULT_WELCOME = `You have joined a collaboration, not a competition.

Everyone here is capable, and everyone here will be wrong about something
today — that is the ordinary cost of working on a system no single agent can
see all of. When a peer gets something wrong they did not do it carelessly or
on purpose, and they do not need to be told they should have known better.
Note what was wrong and what it cost, so the rest of us learn from it, and
move on. No malice, no anger, no talking down: none of it finds a defect any
faster, and all of it makes the next agent slower to admit the thing only
they can see. Nobody here outranks anybody.

Stay inside what you can actually check. You can read your own code; you
cannot read theirs. Their codebase, their machine and their constraints are
known best by them, so bring what you observed as evidence — the error, the
path, the sizes you read — ask about their side instead of pronouncing on it,
and let them tell you what it means. Corrections run both ways: when a peer
builds against something you specified, read their implementation back,
because the defect may be in what you told them.

Be kind and be brief; here they are the same discipline. Every message you
send wakes somebody and costs them a full turn of thinking, so send what
carries a conclusion and stay quiet otherwise — silence is the
acknowledgement. Praise, apologies and status theatre cost exactly what real
findings cost and buy nothing.

The switchboard skill on your machine has the mechanics and the working
habits in full. Re-read it when this collaboration gets long; this note only
sets the tone.`;

/** Reserved sender name for console-sent messages (see ensureOperatorAgent). */
const OPERATOR_NAME = 'operator';

/** `meta` row holding this data dir's permanent instance id (see ensureInstanceId). */
const INSTANCE_ID_META = 'instance_id';

/** How far the join dedupe probes before giving up: name-2 ... name-1000. */
const MAX_DEDUPE_SUFFIX = 1000;

export interface AgentRow {
  id: number;
  name: string;
  token_hash: string;
  created_at: string;
  line_seq: number;
  last_seen_at: string | null;
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
  sender_name: string | null;
  to_json: string | null;
  subject: string;
  body: string;
  in_reply_to: number | null;
  reply_to_json: string | null;
  wake: number;
  signal: string | null;
  state: string | null;
}

/** A message as it appears on the wire (REST body and WS frame alike). */
export interface WireMessage {
  seq: number;
  ts: string;
  sender: string;
  to: string[] | null;
  /** Null only on operator sends, which may omit it; agents always carry one. */
  subject: string | null;
  body: string;
  /** Scalar when one seq is cited (back-compat), array when several, null when none. */
  in_reply_to: number | number[] | null;
  /** False = record-only: in history and transcripts, never pushed to an agent. */
  wake: boolean;
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
  /** Every cited seq (deduped, validated); empty array = no citations. */
  in_reply_to: number[];
  wake: boolean;
  signal: string | null;
  state: string | null;
}

export class Store {
  public readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ------------------------------------------------------------------ meta

  /**
   * The join key. Stored PLAINTEXT in `meta` on purpose (ARCHITECTURE
   * "Tokens"): the console must be able to re-display it at any time and the
   * database lives on the operator's own machine. Per-identity agent tokens
   * stay hashed.
   */
  getJoinKey(): string {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(JOIN_KEY_META) as
      | { value: string }
      | undefined;
    if (!row) throw new Error(`no '${JOIN_KEY_META}' row in meta: the switchboard was never initialised`);
    return row.value;
  }

  /** Mint the join key on first boot; later boots reuse the stored one. */
  ensureJoinKey(): string {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(JOIN_KEY_META) as
      | { value: string }
      | undefined;
    if (row) return row.value;
    const key = mintJoinKey();
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(JOIN_KEY_META, key);
    return key;
  }

  /** Mint a replacement; the old key stops working the instant this returns. */
  rotateJoinKey(): string {
    const key = mintJoinKey();
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(JOIN_KEY_META, key);
    return key;
  }

  /**
   * The switchboard's epoch: a random id minted the first time this data dir
   * boots and never changed after. Agents record it at join; a mismatch on a
   * later check means "different world — your token, cursors and channel
   * history all predate this instance", which turns a silent rebuild into a
   * deterministic two-line detection (first-users RFC, unanimous item).
   */
  ensureInstanceId(): string {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(INSTANCE_ID_META) as
      | { value: string }
      | undefined;
    if (row) return row.value;
    const id = `sw_i_${randomBytes(8).toString('hex')}`;
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(INSTANCE_ID_META, id);
    return id;
  }

  getInstanceId(): string {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(INSTANCE_ID_META) as
      | { value: string }
      | undefined;
    if (!row) throw new Error(`no '${INSTANCE_ID_META}' row in meta: the switchboard was never initialised`);
    return row.value;
  }

  /**
   * Operator-configured DNS name for the join block (e.g. a tailnet record
   * like `switchboard.<machine>.<domain>`). Null when unset — the console
   * then falls back to the machine's primary IP. Stored in `meta` so it
   * survives restarts with the rest of the switchboard's identity.
   */
  getAdvertisedHost(): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(ADVERTISED_HOST_META) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  /**
   * The welcome handed to agents at join and on every recovery. Never null:
   * an unset row means "the built-in text" (DEFAULT_WELCOME), so an operator
   * who has never touched it still sets a tone.
   */
  getWelcome(): string {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(WELCOME_META) as
      | { value: string }
      | undefined;
    return row ? row.value : DEFAULT_WELCOME;
  }

  /** True when the welcome is the built-in one (nothing stored). */
  isWelcomeDefault(): boolean {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(WELCOME_META);
    return row === undefined;
  }

  /** Null restores the built-in text rather than blanking the welcome. */
  setWelcome(text: string | null): void {
    if (text === null) {
      this.db.prepare('DELETE FROM meta WHERE key = ?').run(WELCOME_META);
      return;
    }
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(WELCOME_META, text);
  }

  setAdvertisedHost(host: string | null): void {
    if (host === null) {
      this.db.prepare('DELETE FROM meta WHERE key = ?').run(ADVERTISED_HOST_META);
      return;
    }
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(ADVERTISED_HOST_META, host);
  }

  // ---------------------------------------------------------------- agents

  createAgent(name: string, tokenHash: string): AgentRow {
    this.assertNameFree(name);
    return this.insertAgent(name, tokenHash);
  }

  /**
   * Enrollment insert for POST /v1/join: probe `name`, `name-2`, `name-3`, ...
   * and take the first free one — a join never fails on a name collision
   * (ARCHITECTURE, POST /v1/join). Probe and insert share one transaction, and
   * better-sqlite3 is synchronous, so nothing can claim the name in between.
   */
  createAgentDeduped(proposed: string, tokenHash: string): AgentRow {
    const enroll = this.db.transaction((): AgentRow => {
      const name = this.firstFreeName(proposed);
      return this.insertAgent(name, tokenHash);
    });
    return enroll();
  }

  /**
   * Rename an agent in place. NOT deduped — the operator chose this exact name
   * on purpose, so a collision is a loud 409 with createAgent's own wording.
   * Message attribution follows automatically: `messages` stores sender_id and
   * every read joins to the current name.
   */
  renameAgent(agentId: number, name: string): void {
    const rename = this.db.transaction((): void => {
      this.assertNameFree(name);
      this.db.prepare('UPDATE agents SET name = ? WHERE id = ?').run(name, agentId);
      // Attribution snapshots follow a LIVING agent's rename; they only
      // freeze at deletion.
      this.db.prepare('UPDATE messages SET sender_name = ? WHERE sender_id = ?').run(name, agentId);
    });
    rename();
  }

  /**
   * The reserved sender identity for console-sent messages. A special agents
   * row: empty token_hash (nothing can ever authenticate as it — the same
   * invariant tombstones rely on), hidden from the roster, its name refused
   * to every join/register/rename. Created lazily on the operator's first
   * send. Messages attribute to it by id like any sender, so transcripts and
   * history render `operator` with zero special cases.
   */
  ensureOperatorAgent(): AgentRow {
    const existing = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(OPERATOR_NAME) as
      | AgentRow
      | undefined;
    if (existing) return existing;
    const created_at = nowIso();
    const info = this.db
      .prepare("INSERT INTO agents(name, token_hash, created_at, line_seq) VALUES (?, '', ?, 0)")
      .run(OPERATOR_NAME, created_at);
    return { id: Number(info.lastInsertRowid), name: OPERATOR_NAME, token_hash: '', created_at, line_seq: 0, last_seen_at: null };
  }

  /**
   * A name is taken only by a LIVE agent. Tombstones no longer squat names:
   * their rows carry mangled `#gone-<id>` names (deleteAgent), and message
   * attribution lives in per-message snapshots, so a deleted agent's name
   * returns to the pool immediately.
   */
  private assertNameFree(name: string): void {
    if (name === OPERATOR_NAME) {
      throw conflict(`the name '${OPERATOR_NAME}' is reserved for the human at the console`);
    }
    if (this.findAgentByName(name)) throw conflict(`agent '${name}' already exists`);
  }

  /** The proposed name, or the first free `-N` variant of it. */
  private firstFreeName(proposed: string): string {
    // 'operator' counts as always-taken: a join proposing it dedupes to
    // operator-2 instead of impersonating the console.
    if (proposed !== OPERATOR_NAME && !this.nameExists(proposed)) return proposed;
    for (let n = 2; n <= MAX_DEDUPE_SUFFIX; n++) {
      const candidate = suffixSlug(proposed, n);
      if (!this.nameExists(candidate)) return candidate;
    }
    throw conflict(
      `'${proposed}' and its first ${MAX_DEDUPE_SUFFIX - 1} numbered variants are all taken — propose another name`,
    );
  }

  /** Any row at all, live or tombstoned: `agents.name` is globally UNIQUE. */
  private nameExists(name: string): boolean {
    return this.db.prepare('SELECT 1 AS ok FROM agents WHERE name = ?').get(name) !== undefined;
  }

  private insertAgent(name: string, tokenHash: string): AgentRow {
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
      last_seen_at: null,
    };
  }

  setAgentTokenHash(agentId: number, tokenHash: string): void {
    this.db.prepare('UPDATE agents SET token_hash = ? WHERE id = ?').run(tokenHash, agentId);
  }

  /** Live agents only — soft-deleted rows are invisible to all lookups. */
  findAgentByName(name: string): AgentRow | undefined {
    return this.db.prepare('SELECT * FROM agents WHERE name = ? AND deleted_at IS NULL').get(name) as
      | AgentRow
      | undefined;
  }

  findAgentByTokenHash(tokenHash: string): AgentRow | undefined {
    return this.db
      .prepare("SELECT * FROM agents WHERE token_hash = ? AND token_hash != '' AND deleted_at IS NULL")
      .get(tokenHash) as AgentRow | undefined;
  }

  getAgentById(id: number): AgentRow {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
    if (!row) throw notFound(`agent id ${id} no longer exists`);
    return row;
  }

  listAgents(): AgentRow[] {
    // token_hash != '' hides the reserved operator row: only tombstones and
    // the operator identity ever carry an empty hash, and tombstones are
    // already excluded by deleted_at.
    return this.db
      .prepare("SELECT * FROM agents WHERE deleted_at IS NULL AND token_hash != '' ORDER BY name")
      .all() as AgentRow[];
  }

  /**
   * Remove an agent. Open-channel memberships are dropped automatically in
   * the same transaction — the operator's intent is unambiguous, and forcing
   * a channel closure to delete one dead member punished the members still
   * using it. If nothing references the row (never sent a message), it is
   * hard-deleted and the name is freed; otherwise it becomes a tombstone —
   * invisible everywhere, token revoked, name retired — so message history
   * and transcripts keep resolving the sender. Returns which happened, plus
   * the open channels it was removed from (the route closes those sockets).
   */
  deleteAgent(name: string): { mode: 'hard' | 'soft'; removedFrom: ChannelRow[] } {
    const del = this.db.transaction((): { mode: 'hard' | 'soft'; removedFrom: ChannelRow[] } => {
      const agent = this.findAgentByName(name);
      if (!agent) throw notFound(`unknown agent '${name}'`);
      const removedFrom = this.openChannelsForAgent(agent.id);
      for (const channel of removedFrom) {
        this.db
          .prepare('DELETE FROM channel_members WHERE channel_id = ? AND agent_id = ?')
          .run(channel.id, agent.id);
      }
      const sent = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ?').get(agent.id) as {
        n: number;
      };
      if (sent.n === 0) {
        this.db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
        return { mode: 'hard', removedFrom };
      }
      // Messages reference the row (FK), so it must survive — but as a
      // MANGLED tombstone: `#` is impossible in a slug, so `#gone-<id>` can
      // never collide, and the agent's real name returns to the pool right
      // now. Attribution is untouched: it reads the per-message snapshot.
      this.db
        .prepare("UPDATE agents SET deleted_at = ?, token_hash = '', name = '#gone-' || id WHERE id = ?")
        .run(nowIso(), agent.id);
      return { mode: 'soft', removedFrom };
    });
    return del();
  }

  /**
   * Record that an agent showed signs of life (a receive path: WS connect or
   * line long-poll). Throttled in memory so a healthy watcher's ~1 request a
   * minute doesn't become a write a minute per agent forever.
   */
  private readonly lastSeenWrites = new Map<number, number>();

  touchAgentSeen(agentId: number): void {
    const last = this.lastSeenWrites.get(agentId);
    const now = Date.now();
    if (last !== undefined && now - last < 30_000) return;
    this.lastSeenWrites.set(agentId, now);
    this.db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(nowIso(), agentId);
  }

  /** Drop one agent's membership in one channel. True if a row was removed. */
  removeChannelMember(channelId: number, agentId: number): boolean {
    const info = this.db
      .prepare('DELETE FROM channel_members WHERE channel_id = ? AND agent_id = ?')
      .run(channelId, agentId);
    return info.changes > 0;
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

  /** Add agents to an open channel; already-members are skipped (UNIQUE constraint). */
  addChannelMembers(channelId: number, agentIds: number[]): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO channel_members(channel_id, agent_id, joined_at) VALUES (?, ?, ?)',
    );
    const add = this.db.transaction((): void => {
      const joined_at = nowIso();
      for (const agentId of agentIds) insert.run(channelId, agentId, joined_at);
    });
    add();
  }

  memberNames(channelId: number): string[] {
    const rows = this.db
      .prepare(
        'SELECT a.name AS name FROM channel_members m JOIN agents a ON a.id = m.agent_id WHERE m.channel_id = ? ORDER BY a.name',
      )
      .all(channelId) as { name: string }[];
    return rows.map((r) => r.name);
  }

  /** Member rows with ids — presence rendering needs id + name + last_seen. */
  memberRows(channelId: number): { id: number; name: string; last_seen_at: string | null }[] {
    return this.db
      .prepare(
        'SELECT a.id, a.name, a.last_seen_at FROM channel_members m JOIN agents a ON a.id = m.agent_id WHERE m.channel_id = ? ORDER BY a.name',
      )
      .all(channelId) as { id: number; name: string; last_seen_at: string | null }[];
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
    senderName: string,
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
          `INSERT INTO messages(channel_id, seq, ts, sender_id, sender_name, to_json, subject, body, in_reply_to, reply_to_json, wake, signal, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          channel.id,
          seq,
          ts,
          senderId,
          senderName,
          msg.to === null ? null : JSON.stringify(msg.to),
          msg.subject,
          msg.body,
          msg.in_reply_to.length > 0 ? msg.in_reply_to[0] : null,
          msg.in_reply_to.length > 0 ? JSON.stringify(msg.in_reply_to) : null,
          msg.wake ? 1 : 0,
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
    // The snapshot is authoritative; the join is only the safety net for a
    // pre-v4 row whose backfill somehow missed (it cannot, but fail soft).
    const rows = this.db
      .prepare(
        `SELECT m.*, COALESCE(m.sender_name, a.name) AS resolved_sender
         FROM messages m JOIN agents a ON a.id = m.sender_id
         WHERE m.channel_id = ? AND m.seq > ? ORDER BY m.seq`,
      )
      .all(channelId, since) as (MessageRow & { resolved_sender: string })[];
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

export function toWireMessage(row: MessageRow & { resolved_sender: string }): WireMessage {
  // Citations: scalar out when one (back-compat with every existing reader),
  // array when several. reply_to_json is authoritative; the legacy scalar
  // column covers pre-v5 rows.
  let inReplyTo: number | number[] | null = row.in_reply_to;
  if (row.reply_to_json !== null) {
    const cited = JSON.parse(row.reply_to_json) as number[];
    inReplyTo = cited.length === 1 ? (cited[0] as number) : cited;
  }
  return {
    seq: row.seq,
    ts: row.ts,
    sender: row.resolved_sender,
    to: row.to_json === null ? null : (JSON.parse(row.to_json) as string[]),
    // '' is the stored form of "no subject" (operator sends may omit it; the
    // column is NOT NULL). Null on the wire so clients branch on one thing.
    subject: row.subject === '' ? null : row.subject,
    body: row.body,
    in_reply_to: inReplyTo,
    wake: row.wake !== 0,
    signal: row.signal,
    state: row.state,
  };
}
