/**
 * The whole /v1 REST surface. One table, one handler per row.
 * Every handler validates loudly and returns a plain JSON result.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  API_VERSION,
  MAX_BODY_CHARS,
  MAX_NOTE_CHARS,
  MAX_PURPOSE_CHARS,
  MAX_SIGNAL_CHARS,
  MAX_SUBJECT_CHARS,
  MAX_ATTACHMENTS,
  MAX_WAIT_SECONDS,
  MAX_WELCOME_CHARS,
  SERVER_VERSION,
  type Ctx,
} from './context';
import { requireAgent, requireJoinKey, requireOperator, type Principal } from './auth';
import { badRequest, conflict, forbidden, notFound } from './errors';
import { closeChannel, emitLineEvent, purgeOlderThan, sendInvitations } from './lifecycle';
import { Hub, injectToken } from './hub';
import type { Req, Result, Route } from './router';
import type { AgentRow, ChannelRow, WakeMode } from './store';
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
    // Liveness per member — "check before you gate work on someone" (RFC).
    // connected = live receive path right now; last_seen_at = last sign of
    // life ever (null = never armed anything).
    presence: ctx.store.memberRows(channel.id).map((m) => ({
      name: m.name,
      connected: ctx.hub.isAgentConnected(m.id),
      last_seen_at: m.last_seen_at,
    })),
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

const getVersion = (ctx: Ctx): Result => ({
  status: 200,
  // `instance` is the epoch: constant for one data dir's lifetime, different
  // after any rebuild/data-dir switch. Agents compare it to the value they
  // recorded at join to detect "new world" deterministically.
  body: { api: API_VERSION, server: SERVER_VERSION, instance: ctx.store.getInstanceId() },
});

/**
 * Where the agent skill file lives, relative to this compiled module. The
 * layout is deliberately the same in both modes, so no CLI flag is needed:
 *
 *   dev:      <repo>/server/dist        -> <repo>/skill/SKILL.md
 *   packaged: <resources>/server/dist   -> <resources>/skill/SKILL.md
 *
 * (electron-builder ships `skill/` as extraResources for exactly this.) The
 * third candidate covers the compiled tests, which run from
 * server/build-test/src — one directory deeper than dist.
 */
const SKILL_PATH_CANDIDATES = [
  path.resolve(__dirname, '..', '..', 'skill', 'SKILL.md'),
  path.resolve(__dirname, '..', '..', '..', 'skill', 'SKILL.md'),
];

/**
 * Hands out the switchboard skill file as plain markdown, unauthenticated.
 *
 * This is how a new agent machine installs the skill in one command instead
 * of hunting for the repo — the console shows the curl line next to the join
 * block. Public on purpose: it is documentation (the same file is in the
 * public repo), it carries no secrets, and requiring a credential would only
 * make bootstrapping harder for the machine that has nothing yet.
 */
const getSkill = (_ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  for (const candidate of SKILL_PATH_CANDIDATES) {
    let text: string;
    try {
      text = fs.readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    return {
      status: 200,
      body: text,
      contentType: 'text/markdown; charset=utf-8',
    };
  }
  throw notFound('this build does not ship the skill file');
};

/**
 * Enrollment. The join key is the only credential accepted here (checked by
 * hand: it is not a Principal, so the route carries auth 'none'). The proposed
 * name is a wish, not a claim — a taken name is silently deduped and the
 * canonical one comes back as `agent`.
 */
const postJoin = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireJoinKey(ctx, req.headers);
  const obj = parseBody(req, ['name']);
  if (!('name' in obj)) throw badRequest("missing required field 'name'");
  const proposed = assertSlug(obj['name'], 'name');
  const token = mintAgentToken();
  const agent = ctx.store.createAgentDeduped(proposed, hashToken(token));
  return {
    status: 201,
    body: {
      agent: agent.name,
      token,
      created_at: agent.created_at,
      instance: ctx.store.getInstanceId(),
      // True when the proposed name was taken and the server picked another.
      // The agent already gets the canonical name back, but a flag is what
      // makes it TELL the human — a silent -3 leaves the operator staring at
      // three near-identical names whose numbers mean nothing.
      deduped: agent.name !== proposed,
      // The operator's welcome: how peers here treat each other. Handed over
      // at the one moment an agent is guaranteed to read it, and repeated on
      // /v1/agents/me so a recovery after compaction gets it back.
      welcome: ctx.store.getWelcome(),
    },
  };
};

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
    body: {
      agent: fresh.name,
      created_at: fresh.created_at,
      channels,
      line_seq: fresh.line_seq,
      instance: ctx.store.getInstanceId(),
      // Repeated here on purpose: /me is the recovery call, and a welcome
      // read once at join is gone after the first compaction.
      welcome: ctx.store.getWelcome(),
    },
  };
};

/**
 * "What am I actually subscribed to?" — the self-diagnosis an agent cannot
 * perform from its own side. Monitors die silently in a compaction, and a
 * careless re-arm leaves two sockets on one channel; both show up here as a
 * number that is wrong, instead of as archaeology through a transcript.
 */
const getSubscriptions = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  const agent = requireAgent(req.principal);
  const live = ctx.hub.subscriptionsFor(agent.id);
  const memberOf = ctx.store.openChannelsForAgent(agent.id).map((c) => c.name);
  return {
    status: 200,
    body: {
      agent: agent.name,
      ...live,
      // Membership without a socket is the other half of the picture: a
      // channel listed here but absent from `channels` above is one you are
      // entitled to hear and are not listening to.
      member_of: memberOf,
      unwatched: memberOf.filter((name) => !live.channels.some((c) => c.channel === name)),
    },
  };
};

/**
 * HTTP long-poll mirror of the control-line WebSocket, for agents whose
 * harness cannot open a WS to this host at all: the Monitor tool refuses
 * private-range addresses (RFC1918, CGNAT, link-local) outright — literal IP
 * or hostname makes no difference — so a cross-machine agent on a home LAN
 * can never arm the socket. Same frames, same cursor semantics, pull instead
 * of push. Invite frames get the caller's own token injected exactly as the
 * WS path does.
 */
const getLineEvents = async (ctx: Ctx, req: Req): Promise<Result> => {
  assertNoUnknownQuery(req.query, ['since', 'wait']);
  if (req.principal.kind !== 'agent') {
    throw forbidden('the control line requires an agent token');
  }
  const agent = req.principal.agent;
  const token = req.principal.token;
  const since = queryInt(req.query, 'since', 0);
  // The HTTP watcher's heartbeat: this is what makes a long-polling agent
  // show as connected in the console (hub.isAgentConnected) and what keeps
  // its persisted last_seen_at fresh (zombie detection in the roster).
  ctx.hub.markLinePoll(agent.id);
  ctx.store.touchAgentSeen(agent.id);

  const waitRaw = req.query.get('wait');
  const wait = waitRaw === null ? 0 : queryInt(req.query, 'wait', 0);
  if (wait > MAX_WAIT_SECONDS) throw badRequest(`query parameter 'wait' must be <= ${MAX_WAIT_SECONDS} seconds`);

  let frames = ctx.store.lineEventsSince(agent.id, since);
  if (frames.length === 0 && wait > 0) {
    await ctx.hub.waitForLineNews(agent.id, wait * 1000);
    frames = ctx.store.lineEventsSince(agent.id, since);
  }
  const fresh = ctx.store.getAgentById(agent.id);
  return {
    status: 200,
    body: { frames: frames.map((f) => injectToken(f, token)), line_seq: fresh.line_seq },
  };
};

const postMessage = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  if (req.principal.kind === 'none') {
    throw forbidden('messages require an agent or operator token');
  }
  // The operator speaks as the reserved 'operator' identity — a real sender
  // row, so attribution/transcripts need no special case. Not a member of
  // anything; accessChannel already waives membership for operator auth.
  const sender =
    req.principal.kind === 'agent' ? req.principal.agent : ctx.store.ensureOperatorAgent();
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

  const obj = parseBody(req, [
    'subject',
    'body',
    'to',
    'in_reply_to',
    'attachments',
    'wake',
    'signal',
    'state',
  ]);
  // Agents must carry a subject — protocol rule 1 (the subject states the
  // conclusion) is what survives a truncated notification, so it is enforced
  // rather than encouraged. The OPERATOR may omit it: a human typing a quick
  // instruction should not have to invent a headline for it, and the console
  // duplicating one line into both fields read as an echo in every transcript.
  // Stored as '' because the column is NOT NULL; normalised back to null at
  // the wire boundary (store.toWireMessage), so clients see subject: null.
  const subject =
    req.principal.kind === 'operator'
      ? (optionalString(obj, 'subject', MAX_SUBJECT_CHARS) ?? '')
      : requireString(obj, 'subject', MAX_SUBJECT_CHARS);
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

  // Citations: a scalar or an array — the fold rule ("answer everything since
  // your last send in one message") makes multi-citation the normal case.
  const cited: number[] = [];
  if ('in_reply_to' in obj && obj['in_reply_to'] !== null && obj['in_reply_to'] !== undefined) {
    const raw = obj['in_reply_to'];
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.length === 0) throw badRequest("field 'in_reply_to' must not be an empty array; omit it instead");
    for (const item of list) {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 1) {
        throw badRequest("field 'in_reply_to' must be a positive integer seq or an array of them");
      }
      if (!ctx.store.seqExists(channel.id, item)) {
        throw badRequest(`field 'in_reply_to' references seq ${item}, which does not exist in channel '${channelName}'`);
      }
      if (!cited.includes(item)) cited.push(item);
    }
  }

  // Attachments: ids from POST /v1/blobs. Validated here so a message can
  // never reference evidence that is not on the server — a broken attachment
  // in a transcript is worse than no attachment.
  const attachments: string[] = [];
  if ('attachments' in obj && obj['attachments'] !== null && obj['attachments'] !== undefined) {
    const raw = obj['attachments'];
    if (!Array.isArray(raw)) throw badRequest("field 'attachments' must be an array of blob ids");
    if (raw.length > MAX_ATTACHMENTS) {
      throw badRequest(`field 'attachments' holds at most ${MAX_ATTACHMENTS} ids`);
    }
    for (const item of raw) {
      if (typeof item !== 'string' || !/^[0-9a-f]{64}$/.test(item)) {
        throw badRequest("field 'attachments' must contain blob ids (64 hex chars) from POST /v1/blobs");
      }
      if (!ctx.store.getBlob(item)) throw badRequest(`field 'attachments' references unknown blob '${item}'`);
      if (!attachments.includes(item)) attachments.push(item);
    }
  }

  const wakeRaw = obj['wake'];
  if ('wake' in obj && typeof wakeRaw !== 'boolean' && wakeRaw !== 'digest') {
    throw badRequest(
      "field 'wake' must be true (wake now), false (record-only, pushed to nobody) or \"digest\" (held, delivered with the addressee's next wake-up)",
    );
  }
  const wake: WakeMode = wakeRaw === false ? false : wakeRaw === 'digest' ? 'digest' : true;

  const signal = optionalString(obj, 'signal', MAX_SIGNAL_CHARS);
  // 'superseded' is the third one the fleet asked for: 'withdrawn' means "I
  // was wrong", 'superseded' means "this crossed with yours and yours wins" —
  // a distinction they had been spelling out in prose.
  const state = optionalString(obj, 'state', 32);
  if (state !== null && state !== 'settled' && state !== 'withdrawn' && state !== 'superseded') {
    throw badRequest("field 'state' must be 'settled', 'withdrawn' or 'superseded'");
  }
  if (state !== null && cited.length === 0) {
    throw badRequest("field 'state' requires 'in_reply_to' (state marks a change on the referenced thread)");
  }

  const stored = ctx.store.appendMessage(
    channel,
    sender.id,
    sender.name,
    { to, subject, body, in_reply_to: cited, attachments, wake, signal, state },
    idempotencyKey,
  );

  ctx.hub.broadcastMessage(channel.id, channel.name, sender.id, {
    seq: stored.seq,
    ts: stored.ts,
    sender: sender.name,
    to,
    // Same normalisation the stored-row path does: '' means "no subject".
    subject: subject === '' ? null : subject,
    body,
    in_reply_to: cited.length === 0 ? null : cited.length === 1 ? (cited[0] as number) : cited,
    attachments: attachments.length === 0 ? null : ctx.store.getBlobs(attachments),
    wake,
    signal,
    state,
  },
  // How the hub finds digests still owed to a connection when a waking frame
  // gives them a ride. Only called when there is such a frame.
  (afterSeq) => ctx.store.messagesSince(channel.id, afterSeq));

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
  const fresh = ctx.store.getChannelById(channel.id);
  let lastSeq = fresh.last_seq;

  if (filterName !== null) {
    // `for=me` means "exactly what push would have delivered": addressed to
    // this agent (or everyone), never its own messages, and never wake:false
    // records — those exist for the transcript and for explicit catch-up
    // reads, not for waking anybody. A plain pull without for=me stays the
    // full party line, records included.
    const mine = messages.filter(
      (m) => m.wake !== false && m.sender !== filterName && Hub.addressedTo(m.to, filterName),
    );
    const wakes = mine.some((m) => m.wake === true);
    if (wakes) {
      // Something is waking this agent anyway, so the held digests ride along
      // — same rule the socket follows.
      messages = mine;
    } else {
      messages = [];
      // Held digests must not be skipped: a long-poll watcher advances its
      // cursor to the `last_seq` we report, so reporting past an undelivered
      // digest would lose it forever. Pin the cursor just below the earliest
      // one instead — the poll returns empty, the digest stays owed, and the
      // next waking message delivers both.
      const earliestHeld = mine.find((m) => m.wake === 'digest');
      if (earliestHeld) lastSeq = Math.min(lastSeq, earliestHeld.seq - 1);
    }
  }
  return { status: 200, body: { messages, last_seq: lastSeq } };
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

const getJoinKey = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  return { status: 200, body: { join_key: ctx.store.getJoinKey() } };
};

const postJoinKeyRotate = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  parseBody(req, []);
  // Agents already hold their own sw_a_ tokens and are untouched by this.
  return { status: 200, body: { join_key: ctx.store.rotateJoinKey() } };
};

const getAdvertisedHost = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  return { status: 200, body: { host: ctx.store.getAdvertisedHost() } };
};

/**
 * Set (or clear, with null) the DNS name the console's join block leads
 * with. A bare host only — the console composes the URL; a scheme, port or
 * path here would silently break every block it generates.
 */
const postAdvertisedHost = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  const obj = parseBody(req, ['host']);
  if (!('host' in obj)) throw badRequest("missing required field 'host' (a DNS name, or null to clear)");
  const raw = obj['host'];
  if (raw === null) {
    ctx.store.setAdvertisedHost(null);
    return { status: 200, body: { host: null } };
  }
  if (typeof raw !== 'string') throw badRequest("field 'host' must be a string or null");
  const host = raw.trim();
  if (host.length === 0 || host.length > 253) {
    throw badRequest("field 'host' must be 1-253 characters (or null to clear)");
  }
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host) || host.includes('..')) {
    throw badRequest(
      "field 'host' must be a bare DNS name or IP — letters, digits, dots and hyphens only (no scheme, port, or path)",
    );
  }
  ctx.store.setAdvertisedHost(host);
  return { status: 200, body: { host } };
};

const getWelcome = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  return {
    status: 200,
    body: { welcome: ctx.store.getWelcome(), is_default: ctx.store.isWelcomeDefault() },
  };
};

/**
 * Replace the welcome agents are handed at join, or pass null to restore the
 * built-in text. There is no way to set it EMPTY on purpose: a switchboard
 * that greets its agents with nothing is a misconfiguration, not a choice.
 */
const postWelcome = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  const obj = parseBody(req, ['welcome']);
  if (!('welcome' in obj)) {
    throw badRequest("missing required field 'welcome' (text, or null to restore the default)");
  }
  const raw = obj['welcome'];
  if (raw === null) {
    ctx.store.setWelcome(null);
    return { status: 200, body: { welcome: ctx.store.getWelcome(), is_default: true } };
  }
  if (typeof raw !== 'string') throw badRequest("field 'welcome' must be a string or null");
  const text = raw.trim();
  if (text.length === 0) {
    throw badRequest("field 'welcome' must not be empty; pass null to restore the default");
  }
  if (text.length > MAX_WELCOME_CHARS) {
    throw badRequest(`field 'welcome' exceeds ${MAX_WELCOME_CHARS} characters`);
  }
  ctx.store.setWelcome(text);
  return { status: 200, body: { welcome: text, is_default: false } };
};

/**
 * Rename an agent. No dedupe: the operator picked this exact name, so a taken
 * or retired one is a 409. The agent keeps its id and token — the persisted
 * `renamed` frame is how it learns, and the hub repoints its live connections
 * so `to:` push filtering never lags behind (ARCHITECTURE "Rename safety").
 */
const postAgentRename = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  const obj = parseBody(req, ['name']);
  if (!('name' in obj)) throw badRequest("missing required field 'name'");
  const next = assertSlug(obj['name'], 'name');
  const current = req.params['name'] as string;
  const agent = ctx.store.findAgentByName(current);
  if (!agent) throw notFound(`unknown agent '${current}'`);
  if (next === agent.name) throw badRequest(`agent '${agent.name}' is already named '${next}'`);

  ctx.store.renameAgent(agent.id, next);
  ctx.hub.renameAgent(agent.id, next);
  emitLineEvent(ctx, agent.id, { type: 'renamed', old: agent.name, new: next });
  return { status: 200, body: { old: agent.name, name: next } };
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

const deleteAgent = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  parseBody(req, []);
  const name = req.params['name'] as string;
  // Resolve BEFORE deleting so the sockets of a hard-deleted agent (whose id
  // is gone afterwards) can still be closed.
  const agent = ctx.store.findAgentByName(name);
  if (!agent) throw notFound(`unknown agent '${name}'`);
  const { mode, removedFrom } = ctx.store.deleteAgent(name);
  ctx.hub.closeAgentSockets(agent.id, 'agent-deleted');
  return {
    status: 200,
    body: { name, deleted: mode, removed_from: removedFrom.map((c) => c.name) },
  };
};

/**
 * Unpatch one agent from an open channel. The removed agent gets a persisted
 * `removed` control frame (its cue to drop that channel's watcher) and its
 * channel sockets are closed; the remaining members are NOT woken — the
 * members list already carries the fact, mirroring how joins work.
 */
const deleteChannelMember = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  parseBody(req, []);
  const channelName = req.params['name'] as string;
  const agentName = req.params['agent'] as string;
  const channel = ctx.store.resolveChannel(channelName);
  if (!channel) throw notFound(`unknown channel '${channelName}'`);
  if (channel.status !== 'open') throw conflict(`channel '${channelName}' is closed`);
  const agent = ctx.store.findAgentByName(agentName);
  if (!agent) throw notFound(`unknown agent '${agentName}'`);
  if (!ctx.store.removeChannelMember(channel.id, agent.id)) {
    throw badRequest(`agent '${agentName}' is not a member of channel '${channelName}'`);
  }
  emitLineEvent(ctx, agent.id, { type: 'removed', channel: channel.name, reason: 'removed-by-operator' });
  ctx.hub.closeAgentChannelSockets(agent.id, channel.id, 'removed-from-channel');
  return { status: 200, body: { name: channel.name, removed: agent.name } };
};

const getAgents = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  const agents = ctx.store.listAgents().map((a) => ({
    name: a.name,
    created_at: a.created_at,
    connected: ctx.hub.isAgentConnected(a.id),
    // ISO-8601 of the last sign of life (WS connect or line long-poll), or
    // null for an agent that never armed anything — the roster's zombie
    // detector.
    last_seen_at: a.last_seen_at,
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

/**
 * Patch more agents into an OPEN channel. Each newcomer gets an ordinary
 * invite frame carrying the channel's current last_seq, so it can replay the
 * whole party line (SPEC's late-joiner rule). Existing members are NOT
 * notified — a "someone joined" frame would wake every member for
 * information the members list already carries; they discover the newcomer
 * when it speaks. Already-member names are reported, not errored: the add
 * is idempotent from the operator's seat.
 */
const postChannelMembers = (ctx: Ctx, req: Req): Result => {
  assertNoUnknownQuery(req.query, []);
  requireOperator(req.principal);
  const channelName = req.params['name'] as string;
  const channel = ctx.store.resolveChannel(channelName);
  if (!channel) throw notFound(`unknown channel '${channelName}'`);
  if (channel.status !== 'open') throw conflict(`channel '${channelName}' is closed`);

  const obj = parseBody(req, ['members']);
  const names = requireStringArray(obj, 'members');
  if (names.length === 0) throw badRequest("field 'members' must name at least one agent");
  const agents = resolveMembers(ctx, names);

  const existing = new Set(ctx.store.memberIds(channel.id));
  const newcomers = agents.filter((a) => !existing.has(a.id));
  const already = agents.filter((a) => existing.has(a.id)).map((a) => a.name);

  ctx.store.addChannelMembers(channel.id, newcomers.map((a) => a.id));
  const added = sendInvitations(ctx, channel, newcomers.map((a) => a.id));
  return { status: 200, body: { name: channel.name, added, already } };
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
  // Public documentation, not data: the skill file every agent installs.
  { method: 'GET', pattern: '/v1/skill', auth: 'none', handler: getSkill },
  // 'none' at the router level: the handler validates the join key itself.
  { method: 'POST', pattern: '/v1/join', auth: 'none', handler: postJoin },

  { method: 'GET', pattern: '/v1/agents/me', auth: 'agent', handler: getAgentsMe },
  // REST twin of the control-line WS: upgrades are intercepted on the HTTP
  // server's 'upgrade' event and never reach this router, so the same path
  // serves both without conflict.
  { method: 'GET', pattern: '/v1/agents/me/line', auth: 'agent', handler: getLineEvents },
  { method: 'GET', pattern: '/v1/agents/me/subscriptions', auth: 'agent', handler: getSubscriptions },
  // auth 'any': agents send as themselves, the operator as the reserved
  // 'operator' identity (see postMessage).
  { method: 'POST', pattern: '/v1/channels/{name}/messages', auth: 'any', handler: postMessage },
  { method: 'GET', pattern: '/v1/channels/{name}/messages', auth: 'any', handler: getMessages },
  { method: 'GET', pattern: '/v1/channels/{name}', auth: 'any', handler: getChannel },
  { method: 'POST', pattern: '/v1/channels/{name}/close', auth: 'any', handler: postChannelClose },
  { method: 'POST', pattern: '/v1/patch-requests', auth: 'agent', handler: postPatchRequest },

  { method: 'POST', pattern: '/v1/agents', auth: 'operator', handler: postAgents },
  { method: 'GET', pattern: '/v1/join-key', auth: 'operator', handler: getJoinKey },
  { method: 'POST', pattern: '/v1/join-key/rotate', auth: 'operator', handler: postJoinKeyRotate },
  { method: 'GET', pattern: '/v1/welcome', auth: 'operator', handler: getWelcome },
  { method: 'POST', pattern: '/v1/welcome', auth: 'operator', handler: postWelcome },
  { method: 'GET', pattern: '/v1/advertised-host', auth: 'operator', handler: getAdvertisedHost },
  { method: 'POST', pattern: '/v1/advertised-host', auth: 'operator', handler: postAdvertisedHost },
  { method: 'POST', pattern: '/v1/agents/{name}/rename', auth: 'operator', handler: postAgentRename },
  { method: 'POST', pattern: '/v1/agents/{name}/reissue', auth: 'operator', handler: postAgentReissue },
  { method: 'DELETE', pattern: '/v1/agents/{name}', auth: 'operator', handler: deleteAgent },
  { method: 'GET', pattern: '/v1/agents', auth: 'operator', handler: getAgents },
  { method: 'POST', pattern: '/v1/channels', auth: 'operator', handler: postChannels },
  { method: 'POST', pattern: '/v1/channels/{name}/members', auth: 'operator', handler: postChannelMembers },
  { method: 'DELETE', pattern: '/v1/channels/{name}/members/{agent}', auth: 'operator', handler: deleteChannelMember },
  { method: 'GET', pattern: '/v1/channels', auth: 'operator', handler: getChannels },
  { method: 'GET', pattern: '/v1/patch-requests', auth: 'operator', handler: getPatchRequests },
  { method: 'POST', pattern: '/v1/patch-requests/{id}/approve', auth: 'operator', handler: postPatchApprove },
  { method: 'POST', pattern: '/v1/patch-requests/{id}/deny', auth: 'operator', handler: postPatchDeny },
  { method: 'GET', pattern: '/v1/archives', auth: 'operator', handler: getArchives },
  { method: 'GET', pattern: '/v1/archives/{id}', auth: 'operator', handler: getArchive },
  { method: 'POST', pattern: '/v1/maintenance/purge', auth: 'operator', handler: postPurge },
];
