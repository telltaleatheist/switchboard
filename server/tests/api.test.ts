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
  const res = await call(h, 'GET', '/v1/version');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { api: 1, server: '0.1.0' });
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

  const operatorSend = await call(h, 'POST', '/v1/channels/cursors/messages', {
    token: h.operatorToken,
    body: { subject: 's', body: 'b' },
  });
  assert.equal(operatorSend.status, 403);
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

  // Agent with message history: refuse while in an open channel, then soft-delete.
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
  const blocked = await call(h, 'DELETE', '/v1/agents/phoenix', { token: h.operatorToken });
  assert.equal(blocked.status, 409, 'deleting a member of an open channel must be refused');

  const sent = await call(h, 'POST', '/v1/channels/deletion-test/messages', {
    token: phoenix.json.token,
    body: { subject: 'last words', body: 'history must keep resolving me' },
  });
  assert.equal(sent.status, 201);
  const closed = await call(h, 'POST', '/v1/channels/deletion-test/close', { token: h.operatorToken });
  assert.equal(closed.status, 200);

  const soft = await call<{ deleted: string }>(h, 'DELETE', '/v1/agents/phoenix', { token: h.operatorToken });
  assert.equal(soft.status, 200);
  assert.equal(soft.json.deleted, 'soft');
  const listed2 = await call<{ agents: any[] }>(h, 'GET', '/v1/agents', { token: h.operatorToken });
  assert.ok(!listed2.json.agents.some((a) => a.name === 'phoenix'), 'soft-deleted agent must vanish from the list');
  const softToken = await call(h, 'GET', '/v1/agents/me', { token: phoenix.json.token });
  assert.equal(softToken.status, 401, 'a soft-deleted agent token must stop working');
  const retired = await call(h, 'POST', '/v1/agents', { token: h.operatorToken, body: { name: 'phoenix' } });
  assert.equal(retired.status, 409, 'a name referenced by history must be retired, not reusable');

  // The closed channel's history must still resolve the deleted sender's name.
  const history = await call<{ messages: any[] }>(h, 'GET', '/v1/channels/deletion-test/messages?since=0', {
    token: h.operatorToken,
  });
  assert.equal(history.status, 200);
  const last = history.json.messages.find((m) => m.subject === 'last words');
  assert.equal(last?.sender, 'phoenix', 'history must keep resolving a soft-deleted sender');
});
