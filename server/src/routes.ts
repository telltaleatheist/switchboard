/**
 * The whole /v1 REST surface. One table, one handler per row.
 * Every handler validates loudly and returns a plain JSON result.
 */

import {
  API_VERSION,
  MAX_BODY_CHARS,
  MAX_NOTE_CHARS,
  MAX_PURPOSE_CHARS,
  MAX_SIGNAL_CHARS,
  MAX_SUBJECT_CHARS,
  MAX_WAIT_SECONDS,
  SERVER_VERSION,
  type Ctx,
} from './context';
import { requireAgent, requireOperator, type Principal } from './auth';
import { badRequest, conflict, forbidden, notFound } from './errors';
import { closeChannel, purgeOlderThan, sendInvitations } from './lifecycle';
import { Hub } from './hub';
import type { Req, Result, Route } from './router';
import type { AgentRow, ChannelRow } from './store';
import { hashToken, mintAgentToken } from './tokens';
import {
  assertNoUnknownFields,
  assertNoUnknownQuery,
  assertSlug,
  asObject,
  optionalPositiveInt,
  optionalString,
  optionalStringArray,
  queryInt,
  requireNonNegativeInt,
  requireString,
  requireStringArray,
} from './util';

// ------------------------------------------------------------------ helpers

function parseBody(req: Req, allowed: readonly string[]): Record<string, unknown> {
  const text = req.bodyText.trim();
  if (text.length === 0) {
    // An absent body is exactly the empty object for endpoints whose contract
    // body is `{}`; endpoints with required fields still fail on the field.
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw badRequest(`request body is not valid JSON: ${(err as Error).message}`);
  }
  const obj = asObject(parsed, 'request body');
  assertNoUnknownFields(obj, allowed);
  return obj;
}

/** Resolve a channel by name and check the caller may touch it at all. */
function accessChannel(ctx: Ctx, principal: Principal, name: string): ChannelRow {
  const channel = ctx.store.resolveChannel(name);
  if (!channel) throw notFound(`unknown channel '${name}'`);
  if (principal.kind === 'agent' && !ctx.store.isMember(channel.id, principal.agent.id)) {
    throw forbidden(`agent '${principal.agent.name}' is not a member of channel '${name}'`);
  }
  return channel;
}

function channelInfo(ctx: Ctx, channel: ChannelRow): Record<string, unknown> {
  return {
    name: channel.name,
    status: channel.status,
    members: ctx.store.memberNames(channel.id),
    last_seq: channel.last_seq,
    created_at: channel.created_at,
    closed_at: channel.closed_at,
    // ISO-8601 UTC of the newest message, or null when none — the operator
    // console's idle display reads this.
    last_message_at: ctx.store.lastMessageTs(channel.id),
    note: channel.note,
  };
}

function resolveMembers(ctx: Ctx, names: string[]): AgentRow[] {
  const agents: AgentRow[] = [];
  for (const name of names) {
    const agent = ctx.store.findAgentByName(name);
    if (!agent) throw badRequest(`unknown agent '${name}'`);
    agents.push(agent);
  }
  return agents;
}

// ------------------------------------------------------------- handlers

const getVersion = (): Result => ({
  status: 200,
  body: { api: API_VERSION, server: SERVER_VERSION },
});

const getAgentsMe = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  const agent = requireAgent(req.principal);
  const fresh = ctx.store.getAgentById(agent.id);
  const channels = ctx.store.openChannelsForAgent(agent.id).map((c) => ({
    name: c.name,
    last_seq: c.last_seq,
    members: ctx.store.memberNames(c.id),
    note: c.note,
  }));
  return {
    status: 200,
    body: { agent: fresh.name, created_at: fresh.created_at, channels, line_seq: fresh.line_seq },
  };
};

const postMessage = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  if (req.principal.kind !== 'agent') {
    throw forbidden('messages are sent by agents; the operator token has no agent identity');
  }
  const sender = req.principal.agent;
  const channelName = req.params['name'] as string;
  const channel = accessChannel(ctx, req.principal, channelName);
  if (channel.status !== 'open') throw conflict(`channel '${channelName}' is closed`);

  const rawKey = req.headers['idempotency-key'];
  if (Array.isArray(rawKey)) throw badRequest('multiple Idempotency-Key headers');
  const idempotencyKey = typeof rawKey === 'string' && rawKey.trim().length > 0 ? rawKey.trim() : null;
  if (idempotencyKey !== null && idempotencyKey.length > 200) {
    throw badRequest('Idempotency-Key exceeds 200 characters');
  }
  if (idempotencyKey !== null) {
    const stored = ctx.store.findIdempotentResult(idempotencyKey, sender.id);
    if (stored) {
      return { status: 200, body: stored, headers: { 'Idempotency-Replayed': 'true' } };
    }
  }

  const obj = parseBody(req, ['subject', 'body', 'to', 'in_reply_to', 'signal', 'state']);
  const subject = requireString(obj, 'subject', MAX_SUBJECT_CHARS);
  const body = requireString(obj, 'body', MAX_BODY_CHARS);
  const to = optionalStringArray(obj, 'to');
  if (to !== null) {
    if (to.length === 0) throw badRequest("field 'to' must not be empty; omit it to address everyone");
    const members = ctx.store.memberNames(channel.id);
    for (const name of to) {
      if (!members.includes(name)) {
        throw badRequest(`field 'to' names '${name}', which is not a member of channel '${channelName}'`);
      }
    }
  }
  const inReplyTo = optionalPositiveInt(obj, 'in_reply_to');
  if (inReplyTo !== null && !ctx.store.seqExists(channel.id, inReplyTo)) {
    throw badRequest(`field 'in_reply_to' references seq ${inReplyTo}, which does not exist in channel '${channelName}'`);
  }
  const signal = optionalString(obj, 'signal', MAX_SIGNAL_CHARS);
  const state = optionalString(obj, 'state', 32);
  if (state !== null && state !== 'settled' && state !== 'withdrawn') {
    throw badRequest("field 'state' must be 'settled' or 'withdrawn'");
  }
  if (state !== null && inReplyTo === null) {
    throw badRequest("field 'state' requires 'in_reply_to' (state marks a change on the referenced thread)");
  }

  const stored = ctx.store.appendMessage(
    channel,
    sender.id,
    { to, subject, body, in_reply_to: inReplyTo, signal, state },
    idempotencyKey,
  );

  ctx.hub.broadcastMessage(channel.id, channel.name, {
    seq: stored.seq,
    ts: stored.ts,
    sender: sender.name,
    to,
    subject,
    body,
    in_reply_to: inReplyTo,
    signal,
    state,
  });

  return { status: 201, body: stored };
};

const getMessages = async (ctx: Ctx, req: Req): Promise<Result> => {
  assertNoUnknownQuery(req.query, ['since', 'wait', 'for']);
  const channelName = req.params['name'] as string;
  const channel = accessChannel(ctx, req.principal, channelName);
  const since = queryInt(req.query, 'since', 0);

  const waitRaw = req.query.get('wait');
  const wait = waitRaw === null ? 0 : queryInt(req.query, 'wait', 0);
  if (wait > MAX_WAIT_SECONDS) throw badRequest(`query parameter 'wait' must be <= ${MAX_WAIT_SECONDS} seconds`);

  const forRaw = req.query.get('for');
  if (forRaw !== null && forRaw !== 'me') throw badRequest("query parameter 'for' accepts only the value 'me'");
  const filterName =
    forRaw === 'me'
      ? req.principal.kind === 'agent'
        ? req.principal.agent.name
        : (() => {
            throw badRequest("query parameter 'for=me' requires an agent token");
          })()
      : null;

  let messages = ctx.store.messagesSince(channel.id, since);
  if (messages.length === 0 && wait > 0 && channel.status === 'open') {
    await ctx.hub.waitForChannelNews(channel.id, wait * 1000);
    messages = ctx.store.messagesSince(channel.id, since);
  }
  if (filterName !== null) {
    messages = messages.filter((m) => Hub.addressedTo(m.to, filterName));
  }
  const fresh = ctx.store.getChannelById(channel.id);
  return { status: 200, body: { messages, last_seq: fresh.last_seq } };
};

const getChannel = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  const channel = accessChannel(ctx, req.principal, req.params['name'] as string);
  return { status: 200, body: channelInfo(ctx, channel) };
};

const postChannelClose = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  parseBody(req, []);
  const channelName = req.params['name'] as string;
  const channel = accessChannel(ctx, req.principal, channelName);
  if (channel.status !== 'open') throw conflict(`channel '${channelName}' is already closed`);
  const result = closeChannel(ctx, channel, 'closed');
  return {
    status: 200,
    body: { transcript: result.transcript, archive_id: result.archiveId, closed_at: result.closedAt },
  };
};

const postPatchRequest = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  const requester = requireAgent(req.principal);
  const obj = parseBody(req, ['with', 'purpose']);
  const withNames = requireStringArray(obj, 'with');
  if (withNames.length === 0) throw badRequest("field 'with' must name at least one other agent");
  if (withNames.includes(requester.name)) throw badRequest("field 'with' must not include the requesting agent");
  resolveMembers(ctx, withNames);
  const purpose = requireString(obj, 'purpose', MAX_PURPOSE_CHARS);
  const row = ctx.store.createPatchRequest(requester.id, withNames, purpose);
  return { status: 201, body: { id: row.id, status: row.status } };
};

// ------------------------------------------------------- operator handlers

const postAgents = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  const obj = parseBody(req, ['name']);
  if (!('name' in obj)) throw badRequest("missing required field 'name'");
  const name = assertSlug(obj['name'], 'name');
  const token = mintAgentToken();
  const agent = ctx.store.createAgent(name, hashToken(token));
  return { status: 201, body: { name: agent.name, token, created_at: agent.created_at } };
};

const postAgentReissue = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  parseBody(req, []);
  const name = req.params['name'] as string;
  const agent = ctx.store.findAgentByName(name);
  if (!agent) throw notFound(`unknown agent '${name}'`);
  const token = mintAgentToken();
  ctx.store.setAgentTokenHash(agent.id, hashToken(token));
  return { status: 200, body: { name: agent.name, token } };
};

const getAgents = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  const agents = ctx.store.listAgents().map((a) => ({
    name: a.name,
    created_at: a.created_at,
    connected: ctx.hub.isAgentConnected(a.id),
    line_seq: a.line_seq,
    channels: ctx.store.channelNamesForAgent(a.id),
  }));
  return { status: 200, body: { agents } };
};

const postChannels = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  const obj = parseBody(req, ['name', 'members', 'note']);
  if (!('name' in obj)) throw badRequest("missing required field 'name'");
  const name = assertSlug(obj['name'], 'name');
  const memberNames = requireStringArray(obj, 'members');
  if (memberNames.length === 0) throw badRequest("field 'members' must name at least one agent");
  const note = optionalString(obj, 'note', MAX_NOTE_CHARS);
  const members = resolveMembers(ctx, memberNames);

  const channel = ctx.store.createChannel(
    name,
    note,
    members.map((m) => m.id),
  );
  const invited = sendInvitations(ctx, channel, members.map((m) => m.id));
  return { status: 201, body: { name: channel.name, invited } };
};

const getChannels = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, ['status']);
  requireOperator(req.principal);
  const status = req.query.get('status');
  if (status !== null && status !== 'open' && status !== 'closed') {
    throw badRequest("query parameter 'status' must be 'open' or 'closed'");
  }
  const channels = ctx.store.listChannels(status).map((c) => channelInfo(ctx, c));
  return { status: 200, body: { channels } };
};

const getPatchRequests = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, ['status']);
  requireOperator(req.principal);
  const status = req.query.get('status');
  if (status !== null && !['pending', 'approved', 'denied'].includes(status)) {
    throw badRequest("query parameter 'status' must be 'pending', 'approved' or 'denied'");
  }
  const requests = ctx.store.listPatchRequests(status).map((r) => ({
    id: r.id,
    requester: ctx.store.getAgentById(r.requester_id).name,
    with: JSON.parse(r.with_json) as string[],
    purpose: r.purpose,
    status: r.status,
    created_at: r.created_at,
  }));
  return { status: 200, body: { requests } };
};

function patchRequestById(ctx: Ctx, raw: string) {
  if (!/^\d+$/.test(raw)) throw badRequest(`patch-request id must be an integer (got '${raw}')`);
  const row = ctx.store.getPatchRequest(Number(raw));
  if (!row) throw notFound(`unknown patch-request ${raw}`);
  return row;
}

const postPatchApprove = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  const obj = parseBody(req, ['name']);
  const row = patchRequestById(ctx, req.params['id'] as string);
  if (row.status !== 'pending') throw conflict(`patch-request ${row.id} is already ${row.status}`);

  const requester = ctx.store.getAgentById(row.requester_id);
  const withNames = JSON.parse(row.with_json) as string[];
  const members = resolveMembers(ctx, [requester.name, ...withNames]);
  const name = 'name' in obj && obj['name'] !== null ? assertSlug(obj['name'], 'name') : `patch-${row.id}`;

  const channel = ctx.store.createChannel(
    name,
    row.purpose,
    members.map((m) => m.id),
  );
  const invited = sendInvitations(ctx, channel, members.map((m) => m.id));
  ctx.store.setPatchRequestStatus(row.id, 'approved');
  return { status: 201, body: { id: row.id, name: channel.name, invited } };
};

const postPatchDeny = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  parseBody(req, []);
  const row = patchRequestById(ctx, req.params['id'] as string);
  if (row.status !== 'pending') throw conflict(`patch-request ${row.id} is already ${row.status}`);
  ctx.store.setPatchRequestStatus(row.id, 'denied');
  return { status: 200, body: {} };
};

const getArchives = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  return { status: 200, body: { archives: ctx.store.listArchives() } };
};

const getArchive = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  const raw = req.params['id'] as string;
  if (!/^\d+$/.test(raw)) throw badRequest(`archive id must be an integer (got '${raw}')`);
  const row = ctx.store.getArchive(Number(raw));
  if (!row) throw notFound(`unknown archive ${raw}`);
  return { status: 200, body: row };
};

const postPurge = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  const obj = parseBody(req, ['older_than_days']);
  const days = requireNonNegativeInt(obj, 'older_than_days');
  const result = purgeOlderThan(ctx, days);
  return { status: 200, body: result };
};

// ------------------------------------------------------------------ table

export const ROUTES: readonly Route[] = [
  { method: 'GET', pattern: '/v1/version', auth: 'none', handler: getVersion },

  { method: 'GET', pattern: '/v1/agents/me', auth: 'agent', handler: getAgentsMe },
  { method: 'POST', pattern: '/v1/channels/{name}/messages', auth: 'agent', handler: postMessage },
  { method: 'GET', pattern: '/v1/channels/{name}/messages', auth: 'any', handler: getMessages },
  { method: 'GET', pattern: '/v1/channels/{name}', auth: 'any', handler: getChannel },
  { method: 'POST', pattern: '/v1/channels/{name}/close', auth: 'any', handler: postChannelClose },
  { method: 'POST', pattern: '/v1/patch-requests', auth: 'agent', handler: postPatchRequest },

  { method: 'POST', pattern: '/v1/agents', auth: 'operator', handler: postAgents },
  { method: 'POST', pattern: '/v1/agents/{name}/reissue', auth: 'operator', handler: postAgentReissue },
  { method: 'GET', pattern: '/v1/agents', auth: 'operator', handler: getAgents },
  { method: 'POST', pattern: '/v1/channels', auth: 'operator', handler: postChannels },
  { method: 'GET', pattern: '/v1/channels', auth: 'operator', handler: getChannels },
  { method: 'GET', pattern: '/v1/patch-requests', auth: 'operator', handler: getPatchRequests },
  { method: 'POST', pattern: '/v1/patch-requests/{id}/approve', auth: 'operator', handler: postPatchApprove },
  { method: 'POST', pattern: '/v1/patch-requests/{id}/deny', auth: 'operator', handler: postPatchDeny },
  { method: 'GET', pattern: '/v1/archives', auth: 'operator', handler: getArchives },
  { method: 'GET', pattern: '/v1/archives/{id}', auth: 'operator', handler: getArchive },
  { method: 'POST', pattern: '/v1/maintenance/purge', auth: 'operator', handler: postPurge },
];
