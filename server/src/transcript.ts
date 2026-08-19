/**
 * Markdown transcript rendering — the bridge-file format agents already know
 * (dated header, then one numbered section per message).
 */

import type { ChannelRow, WireMessage } from './store';

export interface TranscriptInput {
  channel: ChannelRow;
  members: string[];
  messages: WireMessage[];
  closedAt: string;
  reason: string;
}

export function renderTranscript(input: TranscriptInput): string {
  const { channel, members, messages, closedAt, reason } = input;
  const lines: string[] = [];

  lines.push(`# Switchboard channel — ${channel.name}`);
  lines.push('');
  lines.push(`- Opened: ${channel.created_at}`);
  lines.push(`- Closed: ${closedAt}`);
  lines.push(`- Reason: ${reason}`);
  lines.push(`- Members: ${members.length > 0 ? members.join(', ') : '(none)'}`);
  lines.push(`- Messages: ${messages.length}`);
  if (channel.note !== null && channel.note !== '') {
    lines.push(`- Note: ${channel.note}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  if (messages.length === 0) {
    lines.push('_No messages were sent on this channel._');
    lines.push('');
  }

  for (const m of messages) {
    // Operator sends may carry no subject; the heading then ends at the
    // timestamp rather than trailing an empty dash.
    const heading = `## [${m.seq}] ${m.sender} — ${m.ts}`;
    lines.push(m.subject === null || m.subject === '' ? heading : `${heading} — ${m.subject}`);
    lines.push('');
    if (m.in_reply_to !== null) {
      const cited = Array.isArray(m.in_reply_to) ? m.in_reply_to : [m.in_reply_to];
      lines.push(`> in reply to ${cited.map((s) => `[${s}]`).join(', ')}`);
    }
    if (m.to !== null) lines.push(`> to: ${m.to.join(', ')}`);
    if (!m.wake) lines.push(`> record-only (woke nobody)`);
    if (m.signal !== null) lines.push(`> signal: \`${m.signal}\``);
    if (m.state !== null) lines.push(`> state: ${m.state}`);
    if (m.in_reply_to !== null || m.to !== null || !m.wake || m.signal !== null || m.state !== null) lines.push('');
    lines.push(m.body);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`_Archived by Switchboard at ${closedAt}._`);
  lines.push('');

  return lines.join('\n');
}

/** Filesystem-safe archive filename: `<id>-<channel>-<timestamp>.md`. */
export function archiveFilename(id: number, channelName: string, closedAt: string): string {
  const stamp = closedAt.replace(/[:.]/g, '-');
  const safeName = channelName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${id}-${safeName}-${stamp}.md`;
}
