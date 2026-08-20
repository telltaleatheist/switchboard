/**
 * Channel lifecycle mechanics: invitation, close-with-transcript, the idle
 * expiry sweep and the purge (ARCHITECTURE "Lifecycle mechanics").
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ctx } from './context';
import { conflict } from './errors';
import type { ChannelRow } from './store';
import { archiveFilename, renderTranscript } from './transcript';
import { nowIso } from './util';

/** Persist a control-line frame for an agent, then push it to live sockets. */
export function emitLineEvent(ctx: Ctx, agentId: number, frame: Record<string, unknown>): void {
  const stored = ctx.store.appendLineEvent(agentId, frame);
  ctx.hub.pushLineFrame(agentId, stored.frame);
}

/** Push an `invite` frame to every member of a freshly created channel. */
export function sendInvitations(ctx: Ctx, channel: ChannelRow, memberIds: number[]): string[] {
  const members = ctx.store.memberNames(channel.id);
  const invited: string[] = [];
  for (const agentId of memberIds) {
    const agent = ctx.store.getAgentById(agentId);
    emitLineEvent(ctx, agentId, {
      type: 'invite',
      channel: channel.name,
      // v1 simplification: the invite token IS the agent's own token. It is not
      // stored (only the hash exists) — the hub injects it per connection.
      token: null,
      members,
      last_seq: channel.last_seq,
      note: channel.note,
    });
    invited.push(agent.name);
  }
  return invited;
}

export interface CloseResult {
  transcript: string;
  archiveId: number;
  closedAt: string;
}

/**
 * Close a channel: render + archive the transcript, notify every member's
 * control line, drop the channel's sockets, mark it closed.
 */
export function closeChannel(ctx: Ctx, channel: ChannelRow, reason: string): CloseResult {
  if (channel.status !== 'open') throw conflict(`channel '${channel.name}' is already closed`);

  const closedAt = nowIso();
  const members = ctx.store.memberNames(channel.id);
  const memberIds = ctx.store.memberIds(channel.id);
  const messages = ctx.store.messagesSince(channel.id, 0);
  const transcript = renderTranscript({ channel, members, messages, closedAt, reason });

  const archiveId = ctx.store.insertArchive(channel.id, channel.name, closedAt, reason, transcript);
  const file = path.join(ctx.archiveDir, archiveFilename(archiveId, channel.name, closedAt));
  fs.writeFileSync(file, transcript, { encoding: 'utf8' });

  ctx.store.markChannelClosed(channel.id, closedAt);

  for (const agentId of memberIds) {
    emitLineEvent(ctx, agentId, {
      type: 'closed',
      channel: channel.name,
      reason,
      transcript,
    });
  }

  ctx.hub.closeChannelSockets(channel.id, 1000, 'channel-closed');

  return { transcript, archiveId, closedAt };
}

/** Close every open channel whose last activity is older than idleDays. */
export function runIdleSweep(ctx: Ctx, now: number = Date.now()): string[] {
  const cutoff = now - ctx.config.idleDays * 24 * 60 * 60 * 1000;
  const closed: string[] = [];
  for (const channel of ctx.store.listChannels('open')) {
    const lastTs = ctx.store.lastMessageTs(channel.id) ?? channel.created_at;
    if (Date.parse(lastTs) < cutoff) {
      closeChannel(ctx, channel, 'idle-expiry');
      closed.push(channel.name);
    }
  }
  return closed;
}

export interface PurgeResult {
  deleted: number;
  detail: { archives: number; channels: number; messages: number; idempotency_keys: number };
}

/**
 * Delete archives and closed channels (with their messages) older than N days.
 * Open channels are never touched.
 */
export function purgeOlderThan(ctx: Ctx, olderThanDays: number): PurgeResult {
  const cutoffIso = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const db = ctx.store.db;

  const doomedArchives = db.prepare('SELECT id FROM archives WHERE closed_at < ?').all(cutoffIso) as { id: number }[];
  const doomedChannels = db
    .prepare("SELECT id FROM channels WHERE status = 'closed' AND closed_at IS NOT NULL AND closed_at < ?")
    .all(cutoffIso) as { id: number }[];

  let messages = 0;
  for (const c of doomedChannels) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?').get(c.id) as { n: number };
    messages += row.n;
  }

  const run = db.transaction(() => {
    db.prepare('DELETE FROM archives WHERE closed_at < ?').run(cutoffIso);
    db.prepare("DELETE FROM channels WHERE status = 'closed' AND closed_at IS NOT NULL AND closed_at < ?").run(cutoffIso);
    return db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(cutoffIso).changes;
  });
  const idempotency_keys = run();

  // Drop the on-disk transcript copies for the archives we just removed.
  const doomedIds = new Set(doomedArchives.map((a) => a.id));
  if (doomedIds.size > 0 && fs.existsSync(ctx.archiveDir)) {
    for (const entry of fs.readdirSync(ctx.archiveDir)) {
      const dash = entry.indexOf('-');
      if (dash <= 0) continue;
      const id = Number(entry.slice(0, dash));
      if (Number.isInteger(id) && doomedIds.has(id)) {
        fs.rmSync(path.join(ctx.archiveDir, entry), { force: true });
      }
    }
  }

  return {
    deleted: doomedArchives.length,
    detail: {
      archives: doomedArchives.length,
      channels: doomedChannels.length,
      messages,
      idempotency_keys,
    },
  };
}
