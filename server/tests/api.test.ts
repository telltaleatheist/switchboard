/**
 * End-to-end tests against a real spawned server process.
 * Covers the whole /v1 contract: auth, channels, cursors, push filtering,
 * idempotency, long-poll, close/transcript, archives, purge, patch requests.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameLog, call, sleep, startServer, wsUpgradeStatus, type Harness } from './helpers';

let h: Harness;
let alphaToken: string;
let betaToken: string;
let gammaToken: string;

async function createAgent(name: string): Promise<string> {
  const res = await call<{ name: string; token: string }>(h, 'POST', '/v1/agents', {
    token: h.operatorToken,
    body: { name },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.match(res.json.token, /^sw_a_[0-9a-f]{32}$/);
  return res.json.token;
}

async function createChannel(name: string, members: string[], note?: string): Promise<void> {
  const body: Record<string, unknown> = { name, members };
  if (note !== undefined) body['note'] = note;
  const res = await call(h, 'POST', '/v1/channels', { token: h.operatorToken, body });
  assert.equal(res.status, 201, JSON.stringify(res.json));
}

async function send(
  token: string,
  channel: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ seq: number; ts: string }> {
  const res = await call<{ seq: number; ts: string }>(h, 'POST', `/v1/channels/${channel}/messages`, {
    token,
    body,
    headers,
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

before(async () => {
  h = await startServer();
  alphaToken = await createAgent('alpha');
  betaToken = await createAgent('beta');
  gammaToken = await createAgent('gamma');
});

after(async () => {
  const code = await h.stop();
  assert.equal(code, 0, 'server should exit 0 after graceful shutdown');
  h.cleanup();
});

// --------------------------------------------------------------- version

test('GET /v1/version needs no auth and reports the frozen api version', async () => {
  const res = await call<{ api: number; server: string; instance: string }>(h, 'GET', '/v1/version');
  assert.equal(res.status, 200);
  assert.equal(res.json.api, 1);
  assert.equal(res.json.server, '0.1.0');
  assert.match(res.json.instance, /^sw_i_[0-9a-f]{16}$/);
});

test('GET /v1/skill serves the agent skill file as markdown, unauthenticated', async () => {
  // Fetched directly rather than via call(): this is the one endpoint whose
  // response body is markdown, not JSON.
  const res = await fetch(`http://127.0.0.1:${h.port}/v1/skill`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/markdown/);
  const text = await res.text();
  assert.match(text, /^---\r?\nname: switchboard\r?\n/);
  assert.match(text, /## 1\. Parse the bootstrap block/);
});

test('unknown endpoints 404 and wrong methods 405', async () => {
  const missing = await call(h, 'GET', '/v1/nope');
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /no such endpoint/);
  const wrongMethod = await call(h, 'DELETE', '/v1/version');
  assert.equal(wrongMethod.status, 405);
});

// ------------------------------------------------------------------ auth

test('auth failures are loud: 401 for missing/bad tokens, 403 for wrong scope', async () => {
  const noHeader = await call(h, 'GET', '/v1/agents/me');
  assert.equal(noHeader.status, 401);
  assert.match(noHeader.json.error, /Authorization/);

  const garbage = await call(h, 'GET', '/v1/agents/me', { token: 'sw_a_deadbeef' });
  assert.equal(garbage.status, 401);

  const fakeOperator = await call(h, 'GET', '/v1/agents', { token: 'sw_o_00000000000000000000000000000000' });
  assert.equal(fakeOperator.status, 401);

  const malformed = await fetch(`http://127.0.0.1:${h.port}/v1/agents/me`, { headers: { Authorization: 'Token x' } });
  assert.equal(malformed.status, 401);

  const agentOnOperatorRoute = await call(h, 'POST', '/v1/agents', { token: alphaToken, body: { name: 'nope' } });
  assert.equal(agentOnOperatorRoute.status, 403);
  assert.match(agentOnOperatorRoute.json.error, /operator token/);

  const operatorOnAgentRoute = await call(h, 'GET', '/v1/agents/me', { token: h.operatorToken });
  assert.equal(operatorOnAgentRoute.status, 403);
});

test('operator can register agents; duplicates 409 and bad names 400', async () => {
  const dup = await call(h, 'POST', '/v1/agents', { token: h.operatorToken, body: { name: 'alpha' } });
  assert.equal(dup.status, 409);

  const badName = await call(h, 'POST', '/v1/agents', { token: h.operatorToken, body: { name: 'Not A Slug' } });
  assert.equal(badName.status, 400);
  assert.match(badName.json.error, /slug/);

  const missing = await call(h, 'POST', '/v1/agents', { token: h.operatorToken, body: {} });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /missing required field 'name'/);

  const list = await call<{ agents: { name: string }[] }>(h, 'GET', '/v1/agents', { token: h.operatorToken });
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.json.agents.map((a) => a.name).sort(),
    ['alpha', 'beta', 'gamma'],
  );
});

test('reissue mints a new token and invalidates the old one', async () => {
  const token = await createAgent('rotate-me');
  const before = await call(h, 'GET', '/v1/agents/me', { token });
  assert.equal(before.status, 200);

  const res = await call<{ token: string }>(h, 'POST', '/v1/agents/rotate-me/reissue', { token: h.operatorToken });
  assert.equal(res.status, 200);
  assert.notEqual(res.json.token, token);

  const oldToken = await call(h, 'GET', '/v1/agents/me', { token });
  assert.equal(oldToken.status, 401);
  const newToken = await call(h, 'GET', '/v1/agents/me', { token: res.json.token });
  assert.equal(newToken.status, 200);
});

// ------------------------------------------------ channels + control lines

test('creating a channel pushes invitations onto every member control line', async () => {
  const alphaLine = await FrameLog.open(h, `/v1/agents/me/line?token=${alphaToken}&since=0`);
  const betaLine = await FrameLog.open(h, `/v1/agents/me/line?token=${betaToken}&since=0`);
  try {
    const res = await call<{ name: string; invited: string[] }>(h, 'POST', '/v1/channels', {
      token: h.operatorToken,
      body: { name: 'invite-test', members: ['alpha', 'beta'], note: 'why we are here' },
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.json, { name: 'invite-test', invited: ['alpha', 'beta'] });

    const frameA = await alphaLine.next();
    assert.equal(frameA.type, 'invite');
    assert.equal(frameA.channel, 'invite-test');
    assert.equal(frameA.line_seq, 1);
    assert.deepEqual(frameA.members, ['alpha', 'beta']);
    assert.equal(frameA.last_seq, 0);
    assert.equal(frameA.note, 'why we are here');
    // v1 simplification: the invite token repeats the receiving agent's token.
    assert.equal(frameA.token, alphaToken);

    const frameB = await betaLine.next();
    assert.equal(frameB.type, 'invite');
    assert.equal(frameB.token, betaToken);

    // The line is replayable from a cursor, like any other feed.
    const replay = await FrameLog.open(h, `/v1/agents/me/line?token=${alphaToken}&since=0`);
    const replayed = await replay.next();
    assert.equal(replayed.channel, 'invite-test');
    replay.close();

    // ... and since=<line_seq> replays nothing (idle connect wakes nobody).
    const quiet = await FrameLog.open(h, `/v1/agents/me/line?token=${alphaToken}&since=${frameA.line_seq}`);
    await quiet.expectSilence(200);
    quiet.close();
  } finally {
    alphaLine.close();
    betaLine.close();
  }
});

test('GET /v1/agents/me reports standing channels and the line cursor', async () => {
  const res = await call<{ agent: string; channels: any[]; line_seq: number }>(h, 'GET', '/v1/agents/me', {
    token: alphaToken,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.agent, 'alpha');
  assert.ok(res.json.line_seq >= 1);
  const channel = res.json.channels.find((c) => c.name === 'invite-test');
  assert.ok(channel, 'invite-test should be a standing channel');
  assert.deepEqual(channel.members, ['alpha', 'beta']);
});

test('channel name collisions among open channels are 409, unknown members 400', async () => {
  const collision = await call(h, 'POST', '/v1/channels', {
    token: h.operatorToken,
    body: { name: 'invite-test', members: ['alpha'] },
  });
  assert.equal(collision.status, 409);

  const unknownMember = await call(h, 'POST', '/v1/channels', {
    token: h.operatorToken,
    body: { name: 'ghosts', members: ['nobody'] },
  });
  assert.equal(unknownMember.status, 400);
  assert.match(unknownMember.json.error, /unknown agent 'nobody'/);

  const unknownField = await call(h, 'POST', '/v1/channels', {
    token: h.operatorToken,
    body: { name: 'x1', members: ['alpha'], colour: 'red' },
  });
  assert.equal(unknownField.status, 400);
  assert.match(unknownField.json.error, /unknown field 'colour'/);
});

test('non-members get 403 and unknown channels 404', async () => {
  const notMember = await call(h, 'GET', '/v1/channels/invite-test', { token: gammaToken });
  assert.equal(notMember.status, 403);
  assert.match(notMember.json.error, /not a member/);

  const unknown = await call(h, 'GET', '/v1/channels/no-such-channel', { token: alphaToken });
  assert.equal(unknown.status, 404);

  const wsStatus = await wsUpgradeStatus(h, `/v1/channels/invite-test/ws?token=${gammaToken}&since=0`);
  assert.equal(wsStatus, 403);

  const noToken = await wsUpgradeStatus(h, '/v1/channels/invite-test/ws?since=0');
  assert.equal(noToken, 401);
});

// ------------------------------------------------------- send + cursors

test('send and read with cursors; server assigns seq, ts and sender', async () => {
  await createChannel('cursors', ['alpha', 'beta']);

  const first = await send(alphaToken, 'cursors', { subject: 'one', body: 'first body' });
  assert.equal(first.seq, 1);
  assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const second = await send(betaToken, 'cursors', { subject: 'two', body: 'second body', in_reply_to: 1 });
  assert.equal(second.seq, 2);

  const all = await call<{ messages: any[]; last_seq: number }>(h, 'GET', '/v1/channels/cursors/messages?since=0', {
    token: betaToken,
  });
  assert.equal(all.status, 200);
  assert.equal(all.json.last_seq, 2);
  assert.equal(all.json.messages.length, 2);
  assert.deepEqual(all.json.messages[0], {
    seq: 1,
    ts: first.ts,
    sender: 'alpha',
    to: null,
    subject: 'one',
    body: 'first body',
    in_reply_to: null,
    wake: true,
    attachments: null,
    signal: null,
    state: null,
  });
  assert.equal(all.json.messages[1].sender, 'beta');
  assert.equal(all.json.messages[1].in_reply_to, 1);

  const tail = await call<{ messages: any[] }>(h, 'GET', '/v1/channels/cursors/messages?since=1', { token: alphaToken });
  assert.equal(tail.json.messages.length, 1);
  assert.equal(tail.json.messages[0].seq, 2);

  const caughtUp = await call<{ messages: any[] }>(h, 'GET', '/v1/channels/cursors/messages?since=2', {
    token: alphaToken,
  });
  assert.deepEqual(caughtUp.json.messages, []);

  const badSince = await call(h, 'GET', '/v1/channels/cursors/messages?since=abc', { token: alphaToken });
  assert.equal(badSince.status, 400);

  const badQuery = await call(h, 'GET', '/v1/channels/cursors/messages?sinc=1', { token: alphaToken });
  assert.equal(badQuery.status, 400);
  assert.match(badQuery.json.error, /unknown query parameter 'sinc'/);
});

test('message validation fails loudly', async () => {
  const noSubject = await call(h, 'POST', '/v1/channels/cursors/messages', {
    token: alphaToken,
    body: { body: 'orphan' },
  });
  assert.equal(noSubject.status, 400);
  assert.match(noSubject.json.error, /missing required field 'subject'/);

  const unknownField = await call(h, 'POST', '/v1/channels/cursors/messages', {
    token: alphaToken,
    body: { subject: 's', body: 'b', ts: '2020-01-01' },
  });
  assert.equal(unknownField.status, 400);
  assert.match(unknownField.json.error, /unknown field 'ts'/);

  const nonMemberTo = await call(h, 'POST', '/v1/channels/cursors/messages', {
    token: alphaToken,
    body: { subject: 's', body: 'b', to: ['gamma'] },
  });
  assert.equal(nonMemberTo.status, 400);
  assert.match(nonMemberTo.json.error, /not a member/);

  const emptyTo = await call(h, 'POST', '/v1/channels/cursors/messages', {
    token: alphaToken,
    body: { subject: 's', body: 'b', to: [] },
  });
  assert.equal(emptyTo.status, 400);

  const badReply = await call(h, 'POST', '/v1/channels/cursors/messages', {
    token: alphaToken,
    body: { subject: 's', body: 'b', in_reply_to: 99 },
  });
  assert.equal(badReply.status, 400);

  const badState = await call(h, 'POST', '/v1/channels/cursors/messages', {
    token: alphaToken,
    body: { subject: 's', body: 'b', in_reply_to: 1, state: 'maybe' },
  });
  assert.equal(badState.status, 400);

  const statelessReply = await call(h, 'POST', '/v1/channels/cursors/messages', {
    token: alphaToken,
    body: { subject: 's', body: 'b', state: 'settled' },
  });
  assert.equal(statelessReply.status, 400);

  const brokenJson = await call(h, 'POST', '/v1/channels/cursors/messages', {
    token: alphaToken,
    rawBody: '{"subject": "x", ',
  });
  assert.equal(brokenJson.status, 400);
  assert.match(brokenJson.json.error, /not valid JSON/);

  // The operator CAN speak (as the reserved 'operator' sender — see the
  // dedicated test); a message with no auth at all cannot.
  const anonSend = await call(h, 'POST', '/v1/channels/cursors/messages', {
    body: { subject: 's', body: 'b' },
  });
  assert.equal(anonSend.status, 401);
});

test('invalid UTF-8 in the body is rejected with 400', async () => {
  const invalid = Buffer.concat([
    Buffer.from('{"subject":"mojibake","body":"'),
    Buffer.from([0xff, 0xfe, 0x80]),
    Buffer.from('"}'),
  ]);
  const res = await call(h, 'POST', '/v1/channels/cursors/messages', { token: alphaToken, rawBody: invalid });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /not valid UTF-8/);
});

test('valid UTF-8 beyond ASCII round-trips byte-for-byte', async () => {
  const body = 'Ünïcøde — 日本語 — 🛰️';
  const sent = await send(alphaToken, 'cursors', { subject: 'unicode ✓', body });
  const res = await call<{ messages: any[] }>(h, 'GET', `/v1/channels/cursors/messages?since=${sent.seq - 1}`, {
    token: alphaToken,
  });
  assert.equal(res.json.messages[0].body, body);
  assert.equal(res.json.messages[0].subject, 'unicode ✓');
});

test('bodies over 1 MB are rejected with 413', async () => {
  const huge = JSON.stringify({ subject: 'big', body: 'x'.repeat(1024 * 1024 + 64) });
  const res = await call(h, 'POST', '/v1/channels/cursors/messages', { token: alphaToken, rawBody: huge });
  assert.equal(res.status, 413);
  assert.match(res.json.error, /byte limit/);
});

test('Idempotency-Key replays the original result instead of appending twice', async () => {
  await createChannel('idem', ['alpha', 'beta']);
  const headers = { 'Idempotency-Key': 'retry-after-timeout-1' };
  const first = await call<{ seq: number; ts: string }>(h, 'POST', '/v1/channels/idem/messages', {
    token: alphaToken,
    body: { subject: 'once', body: 'only once' },
    headers,
  });
  assert.equal(first.status, 201);

  const replay = await call<{ seq: number; ts: string }>(h, 'POST', '/v1/channels/idem/messages', {
    token: alphaToken,
    body: { subject: 'once', body: 'only once' },
    headers,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  assert.deepEqual(replay.json, first.json);

  const history = await call<{ messages: any[] }>(h, 'GET', '/v1/channels/idem/messages?since=0', { token: alphaToken });
  assert.equal(history.json.messages.length, 1);

  // The key is scoped per agent: beta reusing it appends its own message.
  const betaSame = await call<{ seq: number }>(h, 'POST', '/v1/channels/idem/messages', {
    token: betaToken,
    body: { subject: 'beta too', body: 'different sender' },
    headers,
  });
  assert.equal(betaSame.status, 201);
  assert.equal(betaSame.json.seq, 2);
});

// ------------------------------------------------------- push filtering

test('push filtering: an addressed message never reaches an unaddressed member', async () => {
  await createChannel('filtered', ['alpha', 'beta']);
  const betaWs = await FrameLog.open(h, `/v1/channels/filtered/ws?token=${betaToken}&since=0`);
  const alphaWs = await FrameLog.open(h, `/v1/channels/filtered/ws?token=${alphaToken}&since=0`);
  const operatorWs = await FrameLog.open(h, `/v1/channels/filtered/ws?token=${h.operatorToken}&since=0`);
  try {
    const addressed = await send(alphaToken, 'filtered', {
      subject: 'for alpha only',
      body: 'private-ish',
      to: ['alpha'],
    });
    const broadcast = await send(alphaToken, 'filtered', { subject: 'for everyone', body: 'party line' });
    const fromBeta = await send(betaToken, 'filtered', { subject: 'beta speaks', body: 'reply' });

    // beta was NOT addressed by the first message, and is never echoed its own
    // send: its socket sees only alpha's broadcast.
    const betaFrame = await betaWs.next();
    assert.equal(betaFrame.type, 'message');
    assert.equal(betaFrame.channel, 'filtered');
    assert.equal(betaFrame.message.seq, broadcast.seq);
    await betaWs.expectSilence(200);
    assert.equal(betaWs.frames.length, 1, 'beta must be woken exactly once');

    // alpha is never live-pushed its own sends — not even the one addressed
    // to itself. Its POST responses already confirmed them; the only frame
    // that wakes it is beta's.
    assert.equal((await alphaWs.next()).message.seq, fromBeta.seq);
    await alphaWs.expectSilence(200);
    assert.equal(alphaWs.frames.length, 1, 'alpha must be woken only by beta');

    // The operator is not a member: its socket is unfiltered and hears all three.
    assert.equal((await operatorWs.next()).message.seq, addressed.seq);
    assert.equal((await operatorWs.next()).message.seq, broadcast.seq);
    assert.equal((await operatorWs.next()).message.seq, fromBeta.seq);

    // Pull stays transparent: beta's history contains the addressed message...
    const history = await call<{ messages: any[] }>(h, 'GET', '/v1/channels/filtered/messages?since=0', {
      token: betaToken,
    });
    assert.deepEqual(
      history.json.messages.map((m) => m.seq),
      [addressed.seq, broadcast.seq, fromBeta.seq],
    );
    assert.deepEqual(history.json.messages[0].to, ['alpha']);

    // ... unless it explicitly asks for the push-filtered view, which mirrors
    // push EXACTLY: not addressed-away messages, and never beta's own sends
    // (the long-poll watcher must not wake an agent for its own words).
    const filtered = await call<{ messages: any[] }>(h, 'GET', '/v1/channels/filtered/messages?since=0&for=me', {
      token: betaToken,
    });
    assert.deepEqual(
      filtered.json.messages.map((m) => m.seq),
      [broadcast.seq],
    );

    const operatorFilter = await call(h, 'GET', '/v1/channels/filtered/messages?since=0&for=me', {
      token: h.operatorToken,
    });
    assert.equal(operatorFilter.status, 400);

    const badFor = await call(h, 'GET', '/v1/channels/filtered/messages?since=0&for=you', { token: betaToken });
    assert.equal(badFor.status, 400);
  } finally {
    betaWs.close();
    alphaWs.close();
    operatorWs.close();
  }
});

test('a channel WS replays from its cursor then streams live', async () => {
  await createChannel('replay', ['alpha', 'beta']);
  await send(alphaToken, 'replay', { subject: 'before-1', body: 'b1' });
  await send(alphaToken, 'replay', { subject: 'before-2', body: 'b2' });

  const ws = await FrameLog.open(h, `/v1/channels/replay/ws?token=${betaToken}&since=1`);
  const alphaWs = await FrameLog.open(h, `/v1/channels/replay/ws?token=${alphaToken}&since=1`);
  try {
    const replayed = await ws.next();
    assert.equal(replayed.message.seq, 2);
    assert.equal(replayed.message.subject, 'before-2');

    // Replay DOES include the agent's own messages — catch-up after a restart
    // or compaction may need them back...
    const ownReplay = await alphaWs.next();
    assert.equal(ownReplay.message.seq, 2);

    const live = send(alphaToken, 'replay', { subject: 'after', body: 'b3' });
    const liveFrame = await ws.next();
    assert.equal(liveFrame.message.seq, 3);
    await live;

    // ...but live push never echoes the sender its own message.
    await alphaWs.expectSilence(200);
    assert.equal(alphaWs.frames.length, 1, 'alpha replays its own message but is not echoed the live one');
  } finally {
    ws.close();
    alphaWs.close();
  }
});

// ------------------------------------------------------------- long-poll

test('long-poll returns as soon as there is news, and 400s above 60s', async () => {
  await createChannel('longpoll', ['alpha', 'beta']);
  const tooLong = await call(h, 'GET', '/v1/channels/longpoll/messages?since=0&wait=61', { token: betaToken });
  assert.equal(tooLong.status, 400);

  const started = Date.now();
  const pending = call<{ messages: any[]; last_seq: number }>(h, 'GET', '/v1/channels/longpoll/messages?since=0&wait=30', {
    token: betaToken,
  });
  await sleep(250);
  const sent = await send(alphaToken, 'longpoll', { subject: 'woke you', body: 'news' });
  const res = await pending;
  const elapsed = Date.now() - started;

  assert.equal(res.status, 200);
  assert.equal(res.json.messages.length, 1);
  assert.equal(res.json.messages[0].seq, sent.seq);
  assert.ok(elapsed < 10000, `long-poll should return on news, took ${elapsed}ms`);
});

test('long-poll times out empty when nothing happens', async () => {
  await createChannel('longpoll-quiet', ['alpha']);
  const started = Date.now();
  const res = await call<{ messages: any[]; last_seq: number }>(
    h,
    'GET',
    '/v1/channels/longpoll-quiet/messages?since=0&wait=1',
    { token: alphaToken },
  );
  const elapsed = Date.now() - started;
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.messages, []);
  assert.equal(res.json.last_seq, 0);
  assert.ok(elapsed >= 900, `should have waited ~1s, waited ${elapsed}ms`);
});

// ------------------------------------------------ control-line long-poll

test('control line long-poll: replay with injected token, wake on invite, empty timeout', async () => {
  // Replay: alpha's line already carries invite frames from earlier channels;
  // read them over plain HTTP and check the token field is alpha's own.
  const replay = await call<{ frames: any[]; line_seq: number }>(h, 'GET', '/v1/agents/me/line?since=0', {
    token: alphaToken,
  });
  assert.equal(replay.status, 200);
  assert.ok(replay.json.frames.length > 0, 'alpha should have line history by this point in the suite');
  assert.equal(replay.json.line_seq, replay.json.frames.at(-1).line_seq);
  for (const frame of replay.json.frames) {
    if (frame.type === 'invite') assert.equal(frame.token, alphaToken);
  }
  const cursor = replay.json.line_seq;

  // Wake: a pending wait resolves as soon as an invite lands on the line.
  const started = Date.now();
  const pending = call<{ frames: any[]; line_seq: number }>(h, 'GET', `/v1/agents/me/line?since=${cursor}&wait=30`, {
    token: alphaToken,
  });
  await sleep(250);
  await createChannel('line-longpoll', ['alpha']);
  const woken = await pending;
  const elapsed = Date.now() - started;
  assert.equal(woken.status, 200);
  assert.equal(woken.json.frames.length, 1);
  assert.equal(woken.json.frames[0].type, 'invite');
  assert.equal(woken.json.frames[0].channel, 'line-longpoll');
  assert.equal(woken.json.frames[0].token, alphaToken);
  assert.ok(elapsed < 10000, `line long-poll should return on news, took ${elapsed}ms`);

  // Quiet: past the new cursor, a short wait times out empty.
  const quietStart = Date.now();
  const quiet = await call<{ frames: any[]; line_seq: number }>(
    h,
    'GET',
    `/v1/agents/me/line?since=${woken.json.line_seq}&wait=1`,
    { token: alphaToken },
  );
  assert.equal(quiet.status, 200);
  assert.deepEqual(quiet.json.frames, []);
  assert.ok(Date.now() - quietStart >= 900, 'should have waited ~1s');

  // Guards: wait cap and agent-only auth, mirroring the channel endpoint.
  const tooLong = await call(h, 'GET', '/v1/agents/me/line?since=0&wait=61', { token: alphaToken });
  assert.equal(tooLong.status, 400);
  const operator = await call(h, 'GET', '/v1/agents/me/line?since=0', { token: h.operatorToken });
  assert.equal(operator.status, 403);
});

test('adding members to an open channel invites only the newcomers', async () => {
  await createChannel('growing', ['alpha']);
  await send(alphaToken, 'growing', { subject: 'pre-join context', body: 'history the newcomer must be able to read' });

  const betaMe = await call<{ line_seq: number }>(h, 'GET', '/v1/agents/me', { token: betaToken });
  const betaLine = await FrameLog.open(h, `/v1/agents/me/line?token=${betaToken}&since=${betaMe.json.line_seq}`);
  try {
    const res = await call<{ added: string[]; already: string[] }>(h, 'POST', '/v1/channels/growing/members', {
      token: h.operatorToken,
      body: { members: ['beta', 'alpha'] },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.added, ['beta']);
    assert.deepEqual(res.json.already, ['alpha'], 'an existing member is reported, not errored');

    // The newcomer gets an ordinary invite with the channel's high-water
    // mark, so the §4 replay rule covers pre-join history.
    const frame = await betaLine.next();
    assert.equal(frame.type, 'invite');
    assert.equal(frame.channel, 'growing');
    assert.equal(frame.last_seq, 1);
    assert.ok(frame.members.includes('alpha') && frame.members.includes('beta'));

    const history = await call<{ messages: any[] }>(h, 'GET', '/v1/channels/growing/messages?since=0', {
      token: betaToken,
    });
    assert.equal(history.json.messages.length, 1);
    const sent = await send(betaToken, 'growing', { subject: 'late joiner', body: 'caught up', in_reply_to: 1 });
    assert.equal(sent.seq, 2);

    // Guards: unknown agent, agent token, closed channel.
    const badAgent = await call(h, 'POST', '/v1/channels/growing/members', {
      token: h.operatorToken,
      body: { members: ['nobody-here'] },
    });
    assert.equal(badAgent.status, 400);
    const agentAuth = await call(h, 'POST', '/v1/channels/growing/members', {
      token: alphaToken,
      body: { members: ['beta'] },
    });
    assert.equal(agentAuth.status, 403);

    await createChannel('grown-shut', ['alpha']);
    await call(h, 'POST', '/v1/channels/grown-shut/close', { token: h.operatorToken, body: {} });
    const closed = await call(h, 'POST', '/v1/channels/grown-shut/members', {
      token: h.operatorToken,
      body: { members: ['beta'] },
    });
    assert.equal(closed.status, 409);
  } finally {
    betaLine.close();
  }
});

test('unpatching a member removes it, notifies only it, and closes its sockets', async () => {
  await createChannel('shrinking', ['alpha', 'beta']);
  const betaMe = await call<{ line_seq: number }>(h, 'GET', '/v1/agents/me', { token: betaToken });
  const betaLine = await FrameLog.open(h, `/v1/agents/me/line?token=${betaToken}&since=${betaMe.json.line_seq}`);
  const betaChan = await FrameLog.open(h, `/v1/channels/shrinking/ws?token=${betaToken}&since=0`);
  try {
    const res = await call<{ name: string; removed: string }>(h, 'DELETE', '/v1/channels/shrinking/members/beta', {
      token: h.operatorToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.removed, 'beta');

    // beta hears it on its control line (skip the invite that armed first)...
    let frame = await betaLine.next();
    if (frame.type === 'invite') frame = await betaLine.next();
    assert.equal(frame.type, 'removed');
    assert.equal(frame.channel, 'shrinking');
    assert.equal(frame.reason, 'removed-by-operator');

    // ...its channel socket closes, and its access is gone.
    const closeInfo = await betaChan.closeInfo;
    assert.equal(closeInfo.code, 1000);
    assert.equal(closeInfo.reason, 'removed-from-channel');
    const sendAfter = await call(h, 'POST', '/v1/channels/shrinking/messages', {
      token: betaToken,
      body: { subject: 's', body: 'b' },
    });
    assert.equal(sendAfter.status, 403);

    // The channel lives on for the rest.
    const info = await call<{ status: string; members: string[] }>(h, 'GET', '/v1/channels/shrinking', {
      token: h.operatorToken,
    });
    assert.equal(info.json.status, 'open');
    assert.deepEqual(info.json.members, ['alpha']);

    // Guards: not-a-member 400, unknown agent 404, agent auth 403.
    const again = await call(h, 'DELETE', '/v1/channels/shrinking/members/beta', { token: h.operatorToken });
    assert.equal(again.status, 400);
    const ghost = await call(h, 'DELETE', '/v1/channels/shrinking/members/nobody', { token: h.operatorToken });
    assert.equal(ghost.status, 404);
    const agentAuth = await call(h, 'DELETE', '/v1/channels/shrinking/members/alpha', { token: alphaToken });
    assert.equal(agentAuth.status, 403);
  } finally {
    betaLine.close();
    betaChan.close();
  }
});

test('wake:"digest" is held, then rides along with the next waking message', async () => {
  await createChannel('digest', ['alpha', 'beta']);
  const betaWs = await FrameLog.open(h, `/v1/channels/digest/ws?token=${betaToken}&since=0`);
  try {
    // Held: delivered to nobody on its own.
    await send(alphaToken, 'digest', { subject: 'on main now', body: 'fyi', wake: 'digest' });
    await sleep(120);
    assert.equal(betaWs.frames.length, 0, 'a digest must not wake anyone by itself');

    // A plain wake-up flushes it first, in order, then itself.
    await send(alphaToken, 'digest', { subject: 'need you', body: 'gate this' });
    const first = await betaWs.next();
    assert.equal(first.message.seq, 1, 'the held digest arrives ahead of the message that woke us');
    assert.equal(first.message.wake, 'digest');
    const second = await betaWs.next();
    assert.equal(second.message.seq, 2);
    assert.equal(second.message.wake, true);

    // Already delivered: a later wake-up does not repeat it.
    await send(alphaToken, 'digest', { subject: 'again', body: 'more' });
    const third = await betaWs.next();
    assert.equal(third.message.seq, 3);
    assert.equal(betaWs.frames.length, 3, 'no re-delivery of an already-flushed digest');
  } finally {
    betaWs.close();
  }
});

test('a digest-only backlog neither wakes a re-arm nor gets lost by one', async () => {
  await createChannel('digest-replay', ['alpha', 'beta']);
  await send(alphaToken, 'digest-replay', { subject: 'quiet note', body: 'no rush', wake: 'digest' });

  // Re-arming with nothing but a digest waiting must stay silent...
  const silent = await FrameLog.open(h, `/v1/channels/digest-replay/ws?token=${betaToken}&since=0`);
  await sleep(120);
  assert.equal(silent.frames.length, 0, 'reconnecting is not "waking for another reason"');

  // ...and the digest must still be owed, so the next real message brings it.
  await send(alphaToken, 'digest-replay', { subject: 'now it matters', body: 'go' });
  const held = await silent.next();
  assert.equal(held.message.seq, 1);
  const waker = await silent.next();
  assert.equal(waker.message.seq, 2);
  silent.close();

  // The long-poll twin holds its cursor below the held digest rather than
  // reporting past it — otherwise a watcher advancing to last_seq loses it.
  const polled = await call<{ messages: { seq: number }[]; last_seq: number }>(
    h,
    'GET',
    '/v1/channels/digest-replay/messages?since=0&for=me',
    { token: betaToken },
  );
  assert.equal(polled.json.messages.length, 2, 'the wake-up pulls the digest along here too');

  await send(alphaToken, 'digest-replay', { subject: 'held again', body: 'later', wake: 'digest' });
  const stuck = await call<{ messages: unknown[]; last_seq: number }>(
    h,
    'GET',
    '/v1/channels/digest-replay/messages?since=2&for=me',
    { token: betaToken },
  );
  assert.deepEqual(stuck.json.messages, [], 'still held');
  assert.equal(stuck.json.last_seq, 2, 'cursor pinned below the digest, not past it');
});

test('evidence travels: attachments upload once, then ride on a message', async () => {
  await createChannel('evidence', ['alpha', 'beta']);
  // A 1x1 PNG stands in for the screenshot that used to reach only the human.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const upload = await fetch(`http://127.0.0.1:${h.port}/v1/blobs?name=crash.png`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alphaToken}`, 'Content-Type': 'image/png' },
    body: png,
  });
  assert.equal(upload.status, 201);
  const blob = (await upload.json()) as { id: string; bytes: number; media_type: string; name: string };
  assert.match(blob.id, /^[0-9a-f]{64}$/, 'the id is the sha256 of the bytes');
  assert.equal(blob.bytes, png.length);
  assert.equal(blob.name, 'crash.png');

  // Content-addressed: the same bytes again are the same id, not a second copy.
  const again = await fetch(`http://127.0.0.1:${h.port}/v1/blobs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alphaToken}`, 'Content-Type': 'image/png' },
    body: png,
  });
  assert.equal(((await again.json()) as { id: string }).id, blob.id);

  await send(alphaToken, 'evidence', {
    subject: 'the crash, not my retelling of it',
    body: 'screenshot attached',
    attachments: [blob.id],
  });
  const pulled = await call<{ messages: { attachments: { id: string; name: string }[] | null }[] }>(
    h,
    'GET',
    '/v1/channels/evidence/messages?since=0',
    { token: betaToken },
  );
  assert.deepEqual(pulled.json.messages[0]?.attachments?.map((a) => a.name), ['crash.png']);

  // A peer fetches the actual bytes back, byte-for-byte.
  const fetched = await fetch(`http://127.0.0.1:${h.port}/v1/blobs/${blob.id}`, {
    headers: { Authorization: `Bearer ${betaToken}` },
  });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), png);

  // ?token= works too — an <img src> in the console cannot set a header.
  const viaQuery = await fetch(`http://127.0.0.1:${h.port}/v1/blobs/${blob.id}?token=${h.operatorToken}`);
  assert.equal(viaQuery.status, 200);
  // ...but it is still a credential.
  const anonymous = await fetch(`http://127.0.0.1:${h.port}/v1/blobs/${blob.id}`);
  assert.equal(anonymous.status, 401);

  // A message may not reference evidence the server does not hold.
  const dangling = await call(h, 'POST', '/v1/channels/evidence/messages', {
    token: alphaToken,
    body: { subject: 's', body: 'b', attachments: ['0'.repeat(64)] },
  });
  assert.equal(dangling.status, 400);
  assert.match(dangling.json.error, /unknown blob/);
});

test('an agent can see what it is actually subscribed to', async () => {
  await createChannel('subs', ['alpha']);
  const before = await call<{ channels: unknown[]; unwatched: string[]; line_sockets: number }>(
    h,
    'GET',
    '/v1/agents/me/subscriptions',
    { token: alphaToken },
  );
  assert.equal(before.status, 200);
  assert.deepEqual(before.json.channels, [], 'member, but listening to nothing');
  assert.ok(before.json.unwatched.includes('subs'), 'the gap is named, not implied');

  const one = await FrameLog.open(h, `/v1/channels/subs/ws?token=${alphaToken}&since=0`);
  const two = await FrameLog.open(h, `/v1/channels/subs/ws?token=${alphaToken}&since=0`);
  try {
    await sleep(80);
    const during = await call<{ channels: { channel: string; sockets: number }[]; unwatched: string[] }>(
      h,
      'GET',
      '/v1/agents/me/subscriptions',
      { token: alphaToken },
    );
    // The duplicate-Monitor failure mode, visible as a number.
    assert.deepEqual(during.json.channels.find((c) => c.channel === 'subs'), { channel: 'subs', sockets: 2 });
    assert.ok(!during.json.unwatched.includes('subs'));
  } finally {
    one.close();
    two.close();
  }
});

test('presence advances on any authenticated request, not just on connect', async () => {
  const joinKey = (await call<{ join_key: string }>(h, 'GET', '/v1/join-key', { token: h.operatorToken })).json
    .join_key;
  const fresh = await call<{ agent: string; token: string }>(h, 'POST', '/v1/join', {
    token: joinKey,
    body: { name: 'seen-by-request' },
  });
  const roster = async (): Promise<string | null> => {
    const list = await call<{ agents: { name: string; last_seen_at: string | null }[] }>(h, 'GET', '/v1/agents', {
      token: h.operatorToken,
    });
    return list.json.agents.find((a) => a.name === fresh.json.agent)?.last_seen_at ?? null;
  };
  assert.equal(await roster(), null, 'joining is not yet a sign of life');
  await call(h, 'GET', '/v1/agents/me', { token: fresh.json.token });
  assert.notEqual(await roster(), null, 'a plain REST call counts — it is the agent, alive, right now');
});

test('every agent is handed the welcome at join and again on recovery', async () => {
  const joinKey = (await call<{ join_key: string }>(h, 'GET', '/v1/join-key', { token: h.operatorToken })).json
    .join_key;

  const joined = await call<{ token: string; welcome: string; deduped: boolean }>(h, 'POST', '/v1/join', {
    token: joinKey,
    body: { name: 'welcomed' },
  });
  assert.equal(joined.status, 201);
  assert.match(joined.json.welcome, /collaboration, not a competition/);
  assert.equal(joined.json.deduped, false, "a free name is not a dedupe");

  // /me repeats it: that is the call an agent makes after a compaction, which
  // is exactly when a once-delivered welcome would already be gone.
  const me = await call<{ welcome: string }>(h, 'GET', '/v1/agents/me', { token: joined.json.token });
  assert.equal(me.json.welcome, joined.json.welcome);

  // The operator can replace it, and null restores the built-in text.
  const read = await call<{ welcome: string; is_default: boolean }>(h, 'GET', '/v1/welcome', {
    token: h.operatorToken,
  });
  assert.equal(read.json.is_default, true);

  const set = await call<{ welcome: string; is_default: boolean }>(h, 'POST', '/v1/welcome', {
    token: h.operatorToken,
    body: { welcome: '  be excellent to each other  ' },
  });
  assert.equal(set.status, 200);
  assert.equal(set.json.welcome, 'be excellent to each other', 'stored trimmed');
  assert.equal(set.json.is_default, false);

  const second = await call<{ welcome: string }>(h, 'POST', '/v1/join', {
    token: joinKey,
    body: { name: 'welcomed-too' },
  });
  assert.equal(second.json.welcome, 'be excellent to each other');

  // Empty is a misconfiguration, not a way to switch the welcome off.
  const blank = await call(h, 'POST', '/v1/welcome', { token: h.operatorToken, body: { welcome: '   ' } });
  assert.equal(blank.status, 400);

  const restored = await call<{ welcome: string; is_default: boolean }>(h, 'POST', '/v1/welcome', {
    token: h.operatorToken,
    body: { welcome: null },
  });
  assert.equal(restored.json.is_default, true);
  assert.match(restored.json.welcome, /collaboration, not a competition/);

  // Agents cannot read or change it.
  const asAgent = await call(h, 'GET', '/v1/welcome', { token: alphaToken });
  assert.equal(asAgent.status, 403);
});

test("state accepts 'superseded' alongside settled and withdrawn", async () => {
  await createChannel('states', ['alpha', 'beta']);
  await send(alphaToken, 'states', { subject: 'first', body: 'b' });
  const crossed = await send(betaToken, 'states', {
    subject: 'yours wins',
    body: 'we crossed; building against yours',
    in_reply_to: 1,
    state: 'superseded',
  });
  assert.equal(crossed.seq, 2);
  const pulled = await call<{ messages: { state: string | null }[] }>(
    h,
    'GET',
    '/v1/channels/states/messages?since=1',
    { token: alphaToken },
  );
  assert.equal(pulled.json.messages[0]?.state, 'superseded');

  const bogus = await call(h, 'POST', '/v1/channels/states/messages', {
    token: alphaToken,
    body: { subject: 's', body: 'b', in_reply_to: 1, state: 'obsolete' },
  });
  assert.equal(bogus.status, 400);
  assert.match(bogus.json.error, /'settled', 'withdrawn' or 'superseded'/);
});

test('the operator may send without a subject; agents may not', async () => {
  await createChannel('no-subject', ['alpha']);
  const alphaWs = await FrameLog.open(h, `/v1/channels/no-subject/ws?token=${alphaToken}&since=0`);
  try {
    const sent = await call<{ seq: number }>(h, 'POST', '/v1/channels/no-subject/messages', {
      token: h.operatorToken,
      body: { body: 'go ahead and disarm your monitor' },
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.json));

    // Null on the wire — both live push and history read.
    const frame = await alphaWs.next();
    assert.equal(frame.message.subject, null);
    assert.equal(frame.message.body, 'go ahead and disarm your monitor');
    const pulled = await call<{ messages: { subject: string | null }[] }>(
      h,
      'GET',
      '/v1/channels/no-subject/messages?since=0',
      { token: alphaToken },
    );
    assert.equal(pulled.json.messages[0]?.subject, null);

    // An empty string is not a way in through the back door.
    const empty = await call(h, 'POST', '/v1/channels/no-subject/messages', {
      token: h.operatorToken,
      body: { subject: '', body: 'b' },
    });
    assert.equal(empty.status, 400);

    // Agents are still held to protocol rule 1.
    const fromAgent = await call(h, 'POST', '/v1/channels/no-subject/messages', {
      token: alphaToken,
      body: { body: 'no headline' },
    });
    assert.equal(fromAgent.status, 400);
    assert.match(fromAgent.json.error, /missing required field 'subject'/);

    // The transcript heading stops at the timestamp rather than trailing a dash.
    const closed = await call<{ transcript: string }>(h, 'POST', '/v1/channels/no-subject/close', {
      token: h.operatorToken,
      body: {},
    });
    assert.equal(closed.status, 200);
    assert.match(closed.json.transcript, /## \[1\] operator — [^\n—]+\n/);
  } finally {
    alphaWs.close();
  }
});

test('the operator speaks as the reserved sender "operator"', async () => {
  await createChannel('op-voice', ['alpha', 'beta']);
  const alphaWs = await FrameLog.open(h, `/v1/channels/op-voice/ws?token=${alphaToken}&since=0`);
  try {
    const sent = await call<{ seq: number }>(h, 'POST', '/v1/channels/op-voice/messages', {
      token: h.operatorToken,
      body: { subject: 'from the console', body: 'both of you: status?' },
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.json.seq, 1);

    // Members are pushed the message, attributed to 'operator'.
    const frame = await alphaWs.next();
    assert.equal(frame.message.sender, 'operator');
    assert.equal(frame.message.subject, 'from the console');

    // The reserved name cannot be claimed by anyone:
    const reg = await call(h, 'POST', '/v1/agents', { token: h.operatorToken, body: { name: 'operator' } });
    assert.equal(reg.status, 409);
    const ren = await call(h, 'POST', '/v1/agents/alpha/rename', {
      token: h.operatorToken,
      body: { name: 'operator' },
    });
    assert.equal(ren.status, 409);
    const joinKey = (await call<{ join_key: string }>(h, 'GET', '/v1/join-key', { token: h.operatorToken })).json
      .join_key;
    const joined = await call<{ agent: string }>(h, 'POST', '/v1/join', {
      token: joinKey,
      body: { name: 'operator' },
    });
    assert.equal(joined.status, 201);
    assert.equal(joined.json.agent, 'operator-2', 'a join proposing the reserved name dedupes silently');

    // And the reserved row never appears in the roster.
    const list = await call<{ agents: { name: string }[] }>(h, 'GET', '/v1/agents', { token: h.operatorToken });
    assert.ok(!list.json.agents.some((a) => a.name === 'operator'));
  } finally {
    alphaWs.close();
  }
});

test('a long-polling agent shows as connected in the operator listing', async () => {
  const joined = await call<{ agent: string; token: string }>(h, 'POST', '/v1/join', {
    token: (await call<{ join_key: string }>(h, 'GET', '/v1/join-key', { token: h.operatorToken })).json.join_key,
    body: { name: 'http-watcher' },
  });
  assert.equal(joined.status, 201);

  const listAgents = async (): Promise<any> => {
    const res = await call<{ agents: any[] }>(h, 'GET', '/v1/agents', { token: h.operatorToken });
    return res.json.agents.find((a) => a.name === 'http-watcher');
  };

  // Freshly joined, no watcher of any kind yet: offline, never seen.
  const before = await listAgents();
  assert.equal(before.connected, false);
  assert.equal(before.last_seen_at, null);

  // One control-line long-poll (the HTTP watcher's request shape) is the
  // heartbeat that flips it to connected — no WebSocket involved — and
  // stamps the persisted last_seen_at the roster's zombie detector reads.
  await call(h, 'GET', '/v1/agents/me/line?since=0', { token: joined.json.token });
  const after = await listAgents();
  assert.equal(after.connected, true);
  assert.ok(typeof after.last_seen_at === 'string' && after.last_seen_at.length > 0);
});

test('RFC batch: instance epoch, multi-citation replies, wake:false records, presence', async () => {
  // Epoch: present, stable across surfaces, and carried in the stale-token 401.
  const version = await call<{ instance: string }>(h, 'GET', '/v1/version');
  assert.match(version.json.instance, /^sw_i_[0-9a-f]{16}$/);
  const me = await call<{ instance: string }>(h, 'GET', '/v1/agents/me', { token: alphaToken });
  assert.equal(me.json.instance, version.json.instance);
  const stale = await call<{ error: string }>(h, 'GET', '/v1/agents/me', {
    token: 'sw_a_00000000000000000000000000000000',
  });
  assert.equal(stale.status, 401);
  assert.ok(stale.json.error.includes(version.json.instance), '401 must carry the instance id to branch on');

  await createChannel('rfc-batch', ['alpha', 'beta']);
  await send(alphaToken, 'rfc-batch', { subject: 'one', body: 'b1' });
  await send(alphaToken, 'rfc-batch', { subject: 'two', body: 'b2' });

  // Citations: array in → array out; scalar in → scalar out; bad seq → 400.
  const folded = await send(betaToken, 'rfc-batch', {
    subject: 'folded',
    body: 'answers both',
    in_reply_to: [1, 2],
    state: 'settled',
  });
  const single = await send(alphaToken, 'rfc-batch', { subject: 'single', body: 'x', in_reply_to: 1 });
  const hist1 = await call<{ messages: any[] }>(h, 'GET', '/v1/channels/rfc-batch/messages?since=0', {
    token: h.operatorToken,
  });
  assert.deepEqual(hist1.json.messages.find((m) => m.seq === folded.seq)?.in_reply_to, [1, 2]);
  assert.equal(hist1.json.messages.find((m) => m.seq === single.seq)?.in_reply_to, 1);
  const badCite = await call(h, 'POST', '/v1/channels/rfc-batch/messages', {
    token: alphaToken,
    body: { subject: 's', body: 'b', in_reply_to: [1, 99] },
  });
  assert.equal(badCite.status, 400);

  // wake:false: recorded, never pushed to agents (live or replay), hidden
  // from for=me, visible to plain pulls and operator sockets.
  const betaWs = await FrameLog.open(h, `/v1/channels/rfc-batch/ws?token=${betaToken}&since=${single.seq}`);
  const operatorWs = await FrameLog.open(h, `/v1/channels/rfc-batch/ws?token=${h.operatorToken}&since=${single.seq}`);
  try {
    const record = await send(alphaToken, 'rfc-batch', {
      subject: 'receipt: consumed go-signal',
      body: 'record-only',
      wake: false,
      in_reply_to: 1,
    });
    const normal = await send(alphaToken, 'rfc-batch', { subject: 'normal', body: 'wakes beta' });

    const betaFrame = await betaWs.next();
    assert.equal(betaFrame.message.seq, normal.seq, 'beta must be woken only by the normal message');
    await betaWs.expectSilence(200);
    assert.equal(betaWs.frames.length, 1);

    assert.equal((await operatorWs.next()).message.seq, record.seq, 'operator sees the record live');
    assert.equal((await operatorWs.next()).message.seq, normal.seq);

    const forMe = await call<{ messages: any[] }>(
      h,
      'GET',
      `/v1/channels/rfc-batch/messages?since=${single.seq}&for=me`,
      { token: betaToken },
    );
    assert.deepEqual(
      forMe.json.messages.map((m) => m.seq),
      [normal.seq],
      'for=me must mirror push: no records',
    );
    const plain = await call<{ messages: any[] }>(h, 'GET', `/v1/channels/rfc-batch/messages?since=${single.seq}`, {
      token: betaToken,
    });
    assert.deepEqual(
      plain.json.messages.map((m) => m.seq),
      [record.seq, normal.seq],
      'plain pull is the full record',
    );
    assert.equal(plain.json.messages[0].wake, false);

    // Replay: a fresh agent socket skips the record too.
    const betaReplay = await FrameLog.open(h, `/v1/channels/rfc-batch/ws?token=${betaToken}&since=${single.seq}`);
    try {
      const replayed = await betaReplay.next();
      assert.equal(replayed.message.seq, normal.seq, 'replay must not turn records into wake-ups');
    } finally {
      betaReplay.close();
    }
  } finally {
    betaWs.close();
    operatorWs.close();
  }

  // Presence: liveness per member on channel info, for check-before-gating.
  const info = await call<{ presence: { name: string; connected: boolean; last_seen_at: string | null }[] }>(
    h,
    'GET',
    '/v1/channels/rfc-batch',
    { token: h.operatorToken },
  );
  assert.deepEqual(info.json.presence.map((p) => p.name).sort(), ['alpha', 'beta']);
  for (const p of info.json.presence) {
    assert.equal(typeof p.connected, 'boolean');
    assert.ok(p.last_seen_at === null || typeof p.last_seen_at === 'string');
  }
});

// ------------------------------------------------------- advertised host

test('advertised host: set, get, clear, validate, operator-only', async () => {
  const unset = await call<{ host: string | null }>(h, 'GET', '/v1/advertised-host', { token: h.operatorToken });
  assert.equal(unset.status, 200);
  assert.equal(unset.json.host, null);

  const set = await call<{ host: string }>(h, 'POST', '/v1/advertised-host', {
    token: h.operatorToken,
    body: { host: 'switchboard.example-pc.example.com' },
  });
  assert.equal(set.status, 200);
  assert.equal(set.json.host, 'switchboard.example-pc.example.com');
  const got = await call<{ host: string }>(h, 'GET', '/v1/advertised-host', { token: h.operatorToken });
  assert.equal(got.json.host, 'switchboard.example-pc.example.com');

  // A bare host only: anything URL-shaped must be refused loudly, or every
  // join block the console generates from it would be silently broken.
  for (const bad of ['http://x.com', 'x.com:4400', 'x com', 'a..b', '-x.com', '']) {
    const res = await call(h, 'POST', '/v1/advertised-host', { token: h.operatorToken, body: { host: bad } });
    assert.equal(res.status, 400, `should reject '${bad}'`);
  }

  const agentGet = await call(h, 'GET', '/v1/advertised-host', { token: alphaToken });
  assert.equal(agentGet.status, 403);

  const cleared = await call<{ host: null }>(h, 'POST', '/v1/advertised-host', {
    token: h.operatorToken,
    body: { host: null },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.host, null);
  const gone = await call<{ host: null }>(h, 'GET', '/v1/advertised-host', { token: h.operatorToken });
  assert.equal(gone.json.host, null);
});

// ---------------------------------------------------- close + transcript

test('closing a channel archives a transcript and notifies every control line', async () => {
  await createChannel('teardown', ['alpha', 'beta'], 'a short collaboration');
  const alphaMe = await call<{ line_seq: number }>(h, 'GET', '/v1/agents/me', { token: alphaToken });
  const betaMe = await call<{ line_seq: number }>(h, 'GET', '/v1/agents/me', { token: betaToken });

  const alphaLine = await FrameLog.open(h, `/v1/agents/me/line?token=${alphaToken}&since=${alphaMe.json.line_seq}`);
  const betaLine = await FrameLog.open(h, `/v1/agents/me/line?token=${betaToken}&since=${betaMe.json.line_seq}`);
  const channelWs = await FrameLog.open(h, `/v1/channels/teardown/ws?token=${alphaToken}&since=0`);
  try {
    await send(alphaToken, 'teardown', { subject: 'conclusion first', body: 'we agreed on X', signal: 'BETA-GO-SHIP' });
    await send(betaToken, 'teardown', { subject: 'settled', body: 'shipping now', in_reply_to: 1, state: 'settled' });

    const res = await call<{ transcript: string; archive_id: number }>(h, 'POST', '/v1/channels/teardown/close', {
      token: betaToken,
      body: {},
    });
    assert.equal(res.status, 200);
    const transcript = res.json.transcript;
    assert.match(transcript, /# Switchboard channel — teardown/);
    assert.match(transcript, /## \[1\] alpha — .+ — conclusion first/);
    assert.match(transcript, /we agreed on X/);
    assert.match(transcript, /> in reply to \[1\]/);
    assert.match(transcript, /> signal: `BETA-GO-SHIP`/);
    assert.match(transcript, /> state: settled/);
    assert.match(transcript, /- Note: a short collaboration/);

    for (const line of [alphaLine, betaLine]) {
      const frame = await line.next();
      assert.equal(frame.type, 'closed');
      assert.equal(frame.channel, 'teardown');
      assert.equal(frame.reason, 'closed');
      assert.equal(frame.transcript, transcript);
      assert.ok(typeof frame.line_seq === 'number');
    }

    const closeInfo = await channelWs.closeInfo;
    assert.equal(closeInfo.code, 1000);
    assert.equal(closeInfo.reason, 'channel-closed');

    // Closing twice is a loud conflict; sending to a closed channel too.
    const again = await call(h, 'POST', '/v1/channels/teardown/close', { token: betaToken, body: {} });
    assert.equal(again.status, 409);
    const sendAfterClose = await call(h, 'POST', '/v1/channels/teardown/messages', {
      token: alphaToken,
      body: { subject: 's', body: 'b' },
    });
    assert.equal(sendAfterClose.status, 409);

    // History remains readable, and the archive is browsable by the operator.
    const history = await call<{ messages: any[] }>(h, 'GET', '/v1/channels/teardown/messages?since=0', {
      token: alphaToken,
    });
    assert.equal(history.json.messages.length, 2);

    const archives = await call<{ archives: any[] }>(h, 'GET', '/v1/archives', { token: h.operatorToken });
    assert.equal(archives.status, 200);
    const archive = archives.json.archives.find((a) => a.id === res.json.archive_id);
    assert.ok(archive);
    assert.equal(archive.channel_name, 'teardown');
    assert.equal(archive.reason, 'closed');

    const full = await call<{ transcript: string }>(h, 'GET', `/v1/archives/${res.json.archive_id}`, {
      token: h.operatorToken,
    });
    assert.equal(full.json.transcript, transcript);

    const archiveForAgent = await call(h, 'GET', '/v1/archives', { token: alphaToken });
    assert.equal(archiveForAgent.status, 403);

    // The closed name is reusable.
    await createChannel('teardown', ['alpha', 'beta']);
  } finally {
    alphaLine.close();
    betaLine.close();
    channelWs.close();
  }
});

// --------------------------------------------------------- channel lists

test('channel info and listings carry last_message_at for the operator UI', async () => {
  await createChannel('idle-display', ['alpha']);
  const empty = await call<any>(h, 'GET', '/v1/channels/idle-display', { token: alphaToken });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.last_message_at, null);
  assert.equal(empty.json.last_seq, 0);
  assert.equal(empty.json.status, 'open');

  const sent = await send(alphaToken, 'idle-display', { subject: 'tick', body: 'tock' });
  const after = await call<any>(h, 'GET', '/v1/channels/idle-display', { token: alphaToken });
  assert.equal(after.json.last_message_at, sent.ts);

  const list = await call<{ channels: any[] }>(h, 'GET', '/v1/channels?status=open', { token: h.operatorToken });
  assert.equal(list.status, 200);
  const entry = list.json.channels.find((c) => c.name === 'idle-display');
  assert.ok(entry);
  assert.equal(entry.last_message_at, sent.ts);
  assert.deepEqual(entry.members, ['alpha']);
  assert.ok(list.json.channels.every((c) => c.status === 'open'));

  const closedList = await call<{ channels: any[] }>(h, 'GET', '/v1/channels?status=closed', { token: h.operatorToken });
  assert.ok(closedList.json.channels.some((c) => c.name === 'teardown'));

  const badStatus = await call(h, 'GET', '/v1/channels?status=weird', { token: h.operatorToken });
  assert.equal(badStatus.status, 400);
});

// ------------------------------------------------------- patch requests

test('agents request patches; the operator approves and the channel is forged', async () => {
  const req = await call<{ id: number; status: string }>(h, 'POST', '/v1/patch-requests', {
    token: gammaToken,
    body: { with: ['alpha'], purpose: 'compare notes on the migration' },
  });
  assert.equal(req.status, 201);
  assert.equal(req.json.status, 'pending');

  const selfPatch = await call(h, 'POST', '/v1/patch-requests', {
    token: gammaToken,
    body: { with: ['gamma'], purpose: 'talking to myself' },
  });
  assert.equal(selfPatch.status, 400);

  const listed = await call<{ requests: any[] }>(h, 'GET', '/v1/patch-requests?status=pending', {
    token: h.operatorToken,
  });
  assert.equal(listed.status, 200);
  const entry = listed.json.requests.find((r) => r.id === req.json.id);
  assert.ok(entry);
  assert.deepEqual(Object.keys(entry).sort(), ['created_at', 'id', 'purpose', 'requester', 'status', 'with']);
  assert.equal(entry.requester, 'gamma');
  assert.deepEqual(entry.with, ['alpha']);
  assert.equal(entry.purpose, 'compare notes on the migration');
  assert.equal(entry.status, 'pending');

  const gammaLine = await FrameLog.open(h, `/v1/agents/me/line?token=${gammaToken}&since=0`);
  try {
    const approved = await call<{ name: string; invited: string[] }>(
      h,
      'POST',
      `/v1/patch-requests/${req.json.id}/approve`,
      { token: h.operatorToken, body: { name: 'migration-notes' } },
    );
    assert.equal(approved.status, 201);
    assert.equal(approved.json.name, 'migration-notes');
    assert.deepEqual(approved.json.invited.sort(), ['alpha', 'gamma']);

    const invite = await gammaLine.next();
    assert.equal(invite.type, 'invite');
    assert.equal(invite.channel, 'migration-notes');
    assert.equal(invite.note, 'compare notes on the migration');

    const twice = await call(h, 'POST', `/v1/patch-requests/${req.json.id}/approve`, { token: h.operatorToken });
    assert.equal(twice.status, 409);
  } finally {
    gammaLine.close();
  }

  const denyMe = await call<{ id: number }>(h, 'POST', '/v1/patch-requests', {
    token: gammaToken,
    body: { with: ['beta'], purpose: 'not now' },
  });
  const denied = await call(h, 'POST', `/v1/patch-requests/${denyMe.json.id}/deny`, { token: h.operatorToken });
  assert.equal(denied.status, 200);
  const afterDeny = await call<{ requests: any[] }>(h, 'GET', '/v1/patch-requests?status=denied', {
    token: h.operatorToken,
  });
  assert.ok(afterDeny.json.requests.some((r) => r.id === denyMe.json.id));

  const agentList = await call(h, 'GET', '/v1/patch-requests', { token: gammaToken });
  assert.equal(agentList.status, 403);
});

// -------------------------------------------------------------- purge

test('purge removes closed channels and archives but never open ones', async () => {
  await createChannel('to-purge', ['alpha']);
  await send(alphaToken, 'to-purge', { subject: 'ephemeral', body: 'gone soon' });
  const closed = await call(h, 'POST', '/v1/channels/to-purge/close', { token: alphaToken, body: {} });
  assert.equal(closed.status, 200);

  const openBefore = await call<{ channels: any[] }>(h, 'GET', '/v1/channels?status=open', { token: h.operatorToken });
  const openNames = openBefore.json.channels.map((c) => c.name).sort();

  const res = await call<{ deleted: number; detail: any }>(h, 'POST', '/v1/maintenance/purge', {
    token: h.operatorToken,
    body: { older_than_days: 0 },
  });
  assert.equal(res.status, 200);
  assert.ok(res.json.deleted >= 1);
  assert.ok(res.json.detail.messages >= 1);

  const archives = await call<{ archives: any[] }>(h, 'GET', '/v1/archives', { token: h.operatorToken });
  assert.deepEqual(archives.json.archives, []);

  const openAfter = await call<{ channels: any[] }>(h, 'GET', '/v1/channels?status=open', { token: h.operatorToken });
  assert.deepEqual(
    openAfter.json.channels.map((c) => c.name).sort(),
    openNames,
    'open channels must survive a purge',
  );

  const badArg = await call(h, 'POST', '/v1/maintenance/purge', { token: h.operatorToken, body: { older_than_days: -1 } });
  assert.equal(badArg.status, 400);
  const missingArg = await call(h, 'POST', '/v1/maintenance/purge', { token: h.operatorToken, body: {} });
  assert.equal(missingArg.status, 400);
});

test('connection status is reported for agents', async () => {
  const ws = await FrameLog.open(h, `/v1/agents/me/line?token=${betaToken}&since=999`);
  try {
    const list = await call<{ agents: any[] }>(h, 'GET', '/v1/agents', { token: h.operatorToken });
    const beta = list.json.agents.find((a) => a.name === 'beta');
    assert.equal(beta.connected, true);
  } finally {
    ws.close();
  }
  await sleep(150);
  const list = await call<{ agents: any[] }>(h, 'GET', '/v1/agents', { token: h.operatorToken });
  const beta = list.json.agents.find((a) => a.name === 'beta');
  assert.equal(beta.connected, false);
});

test('CORS: preflight succeeds and responses carry the allow-origin header', async () => {
  // Browser-origin clients (Electron renderer, ng serve, browser extensions)
  // preflight non-simple requests; without these headers every UI call fails.
  const preflight = await fetch(`http://127.0.0.1:${h.port}/v1/channels/anything/messages`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:4200',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  const allowedMethods = preflight.headers.get('access-control-allow-methods') ?? '';
  assert.ok(allowedMethods.includes('DELETE'), 'the browser preflights DELETE for agent deletion');
  const allowedHeaders = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase();
  for (const name of ['authorization', 'content-type', 'idempotency-key']) {
    assert.ok(allowedHeaders.includes(name), `preflight must allow the ${name} header`);
  }

  const versioned = await call(h, 'GET', '/v1/version', {});
  assert.equal(versioned.headers.get('access-control-allow-origin'), '*');
  const exposed = (versioned.headers.get('access-control-expose-headers') ?? '').toLowerCase();
  assert.ok(exposed.includes('idempotency-replayed'), 'Idempotency-Replayed must be readable from a browser');
});

test('agent deletion: hard when unused, soft when history references it', async () => {
  // Unknown agent -> 404.
  const missing = await call(h, 'DELETE', '/v1/agents/no-such-agent', { token: h.operatorToken });
  assert.equal(missing.status, 404);

  // Never-used agent: hard delete frees the name completely.
  const doomed = await call<{ name: string; token: string }>(h, 'POST', '/v1/agents', {
    token: h.operatorToken,
    body: { name: 'doomed' },
  });
  assert.equal(doomed.status, 201);
  const hard = await call<{ deleted: string }>(h, 'DELETE', '/v1/agents/doomed', { token: h.operatorToken });
  assert.equal(hard.status, 200);
  assert.equal(hard.json.deleted, 'hard');
  const listed = await call<{ agents: any[] }>(h, 'GET', '/v1/agents', { token: h.operatorToken });
  assert.ok(!listed.json.agents.some((a) => a.name === 'doomed'), 'hard-deleted agent must vanish from the list');
  const staleToken = await call(h, 'GET', '/v1/agents/me', { token: doomed.json.token });
  assert.equal(staleToken.status, 401, 'a deleted agent token must stop working');
  const reused = await call(h, 'POST', '/v1/agents', { token: h.operatorToken, body: { name: 'doomed' } });
  assert.equal(reused.status, 201, 'a hard-deleted name must be reusable');
  await call(h, 'DELETE', '/v1/agents/doomed', { token: h.operatorToken });

  // Agent with message history in an OPEN channel: the delete cascades — the
  // membership is dropped, the channel stays open for everyone else, and the
  // agent tombstones because history references it.
  const phoenix = await call<{ name: string; token: string }>(h, 'POST', '/v1/agents', {
    token: h.operatorToken,
    body: { name: 'phoenix' },
  });
  assert.equal(phoenix.status, 201);
  const chan = await call(h, 'POST', '/v1/channels', {
    token: h.operatorToken,
    body: { name: 'deletion-test', members: ['phoenix', 'alpha'] },
  });
  assert.equal(chan.status, 201);

  const sent = await call(h, 'POST', '/v1/channels/deletion-test/messages', {
    token: phoenix.json.token,
    body: { subject: 'last words', body: 'history must keep resolving me' },
  });
  assert.equal(sent.status, 201);

  const soft = await call<{ deleted: string; removed_from: string[] }>(h, 'DELETE', '/v1/agents/phoenix', {
    token: h.operatorToken,
  });
  assert.deepEqual(soft.json.removed_from, ['deletion-test'], 'delete must report the open channels it left');
  const afterInfo = await call<{ status: string; members: string[] }>(h, 'GET', '/v1/channels/deletion-test', {
    token: h.operatorToken,
  });
  assert.equal(afterInfo.json.status, 'open', 'the channel must survive the deletion');
  assert.deepEqual(afterInfo.json.members, ['alpha'], 'only the deleted agent leaves');
  const closed = await call(h, 'POST', '/v1/channels/deletion-test/close', { token: h.operatorToken });
  assert.equal(closed.status, 200);
  assert.equal(soft.status, 200);
  assert.equal(soft.json.deleted, 'soft');
  const listed2 = await call<{ agents: any[] }>(h, 'GET', '/v1/agents', { token: h.operatorToken });
  assert.ok(!listed2.json.agents.some((a) => a.name === 'phoenix'), 'soft-deleted agent must vanish from the list');
  const softToken = await call(h, 'GET', '/v1/agents/me', { token: phoenix.json.token });
  assert.equal(softToken.status, 401, 'a soft-deleted agent token must stop working');
  const reusable = await call(h, 'POST', '/v1/agents', { token: h.operatorToken, body: { name: 'phoenix' } });
  assert.equal(reusable.status, 201, 'a deleted name must be immediately reusable — no retirement');

  // The closed channel's history must still resolve the ORIGINAL sender's
  // name (the attribution snapshot froze at deletion) even though a new,
  // unrelated agent now holds the same name.
  const history = await call<{ messages: any[] }>(h, 'GET', '/v1/channels/deletion-test/messages?since=0', {
    token: h.operatorToken,
  });
  assert.equal(history.status, 200);
  const last = history.json.messages.find((m) => m.subject === 'last words');
  assert.equal(last?.sender, 'phoenix', 'history must keep resolving a soft-deleted sender');
  await call(h, 'DELETE', '/v1/agents/phoenix', { token: h.operatorToken });
});
