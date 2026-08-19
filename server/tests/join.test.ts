/**
 * Enrollment and identity tests: the join key (POST /v1/join, GET/rotate),
 * silent name dedupe, and operator rename — including the two things a rename
 * must never break, message attribution and live push filtering.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameLog, call, startServer, type Harness } from './helpers';

let h: Harness;
let joinKey: string;

interface JoinResponse {
  agent: string;
  token: string;
  created_at: string;
  /** True when the proposed name was taken and the server picked another. */
  deduped: boolean;
}

/** Manual registration (the compat route) — used to seed fixture agents. */
async function createAgent(name: string): Promise<string> {
  const res = await call<{ name: string; token: string }>(h, 'POST', '/v1/agents', {
    token: h.operatorToken,
    body: { name },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.token;
}

/** Enroll through the real join flow; asserts 201 and returns the body. */
async function join(name: string, key: string = joinKey): Promise<JoinResponse> {
  const res = await call<JoinResponse>(h, 'POST', '/v1/join', { token: key, body: { name } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function createChannel(name: string, members: string[]): Promise<void> {
  const res = await call(h, 'POST', '/v1/channels', { token: h.operatorToken, body: { name, members } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
}

async function send(token: string, channel: string, body: Record<string, unknown>): Promise<{ seq: number }> {
  const res = await call<{ seq: number }>(h, 'POST', `/v1/channels/${channel}/messages`, { token, body });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function currentName(token: string): Promise<string> {
  const res = await call<{ agent: string }>(h, 'GET', '/v1/agents/me', { token });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.agent;
}

before(async () => {
  h = await startServer();
  const key = await call<{ join_key: string }>(h, 'GET', '/v1/join-key', { token: h.operatorToken });
  assert.equal(key.status, 200, JSON.stringify(key.json));
  joinKey = key.json.join_key;
  await createAgent('alpha');
});

after(async () => {
  const code = await h.stop();
  assert.equal(code, 0, 'server should exit 0 after graceful shutdown');
  h.cleanup();
});

// ------------------------------------------------------------------- join

test('the join key is minted on first boot and re-displayable to the operator', async () => {
  assert.match(joinKey, /^sw_j_[0-9a-f]{32}$/);

  // Re-displayable: asking twice gives the same key, not a fresh one.
  const again = await call<{ join_key: string }>(h, 'GET', '/v1/join-key', { token: h.operatorToken });
  assert.equal(again.json.join_key, joinKey);

  const forAgent = await call(h, 'GET', '/v1/join-key', { token: await createAgent('key-peeker') });
  assert.equal(forAgent.status, 403, 'the join key is an operator secret');
});

test('POST /v1/join enrolls an agent that names itself', async () => {
  const enrolled = await join('delta');
  assert.equal(enrolled.agent, 'delta', 'a free name is granted exactly as proposed');
  assert.match(enrolled.token, /^sw_a_[0-9a-f]{32}$/);
  assert.match(enrolled.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  assert.equal(await currentName(enrolled.token), 'delta', 'the minted token must work immediately');

  const listed = await call<{ agents: { name: string }[] }>(h, 'GET', '/v1/agents', { token: h.operatorToken });
  assert.ok(listed.json.agents.some((a) => a.name === 'delta'), 'a joined agent joins the roster');

  const badName = await call(h, 'POST', '/v1/join', { token: joinKey, body: { name: 'Not A Slug' } });
  assert.equal(badName.status, 400);
  assert.match(badName.json.error, /slug/);

  const missing = await call(h, 'POST', '/v1/join', { token: joinKey, body: {} });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /missing required field 'name'/);

  const unknownField = await call(h, 'POST', '/v1/join', { token: joinKey, body: { name: 'x', role: 'boss' } });
  assert.equal(unknownField.status, 400);
  assert.match(unknownField.json.error, /unknown field 'role'/);
});

test('a taken name is silently deduped: alpha -> alpha-2 -> alpha-3', async () => {
  const second = await join('alpha');
  assert.equal(second.agent, 'alpha-2', 'a live name must never fail a join, only shift it');
  assert.equal(second.deduped, true, 'the joiner is told, so it can tell its human');
  const third = await join('alpha');
  assert.equal(third.agent, 'alpha-3');
  assert.equal(third.deduped, true);

  // Distinct identities, not aliases: each token resolves to its own name.
  assert.equal(await currentName(second.token), 'alpha-2');
  assert.equal(await currentName(third.token), 'alpha-3');
  assert.notEqual(second.token, third.token);

  // A deleted name comes straight back to the pool — even when the agent
  // sent messages (the tombstone keeps the FK under a mangled name; the
  // attribution snapshot keeps the history readable).
  const ghostToken = await createAgent('ghost');
  await createChannel('ghost-town', ['ghost', 'alpha']);
  await send(ghostToken, 'ghost-town', { subject: 'boo', body: 'history keeps my name' });
  const closed = await call(h, 'POST', '/v1/channels/ghost-town/close', { token: h.operatorToken, body: {} });
  assert.equal(closed.status, 200);
  const deleted = await call<{ deleted: string }>(h, 'DELETE', '/v1/agents/ghost', { token: h.operatorToken });
  assert.equal(deleted.json.deleted, 'soft', 'ghost has history, so it tombstones rather than vanishing');

  const reborn = await join('ghost');
  assert.equal(reborn.agent, 'ghost', 'a deleted name must be immediately reusable');

  // The old messages still say 'ghost' — the snapshot froze at deletion.
  const history = await call<{ messages: { sender: string }[] }>(
    h,
    'GET',
    '/v1/channels/ghost-town/messages?since=0',
    { token: h.operatorToken },
  );
  assert.equal(history.json.messages[0]?.sender, 'ghost');
});

test('only the current join key enrolls: everything else is 401', async () => {
  const wrongKey = await call(h, 'POST', '/v1/join', {
    token: 'sw_j_00000000000000000000000000000000',
    body: { name: 'intruder' },
  });
  assert.equal(wrongKey.status, 401);

  const agentToken = await join('would-be-recruiter');
  const withAgentToken = await call(h, 'POST', '/v1/join', { token: agentToken.token, body: { name: 'intruder' } });
  assert.equal(withAgentToken.status, 401, 'an agent token cannot enroll more agents');

  const withOperator = await call(h, 'POST', '/v1/join', { token: h.operatorToken, body: { name: 'intruder' } });
  assert.equal(withOperator.status, 401, 'even the operator enrolls only via the join key');

  const noHeader = await call(h, 'POST', '/v1/join', { body: { name: 'intruder' } });
  assert.equal(noHeader.status, 401);
  assert.match(noHeader.json.error, /Authorization/);

  const malformed = await call(h, 'POST', '/v1/join', {
    body: { name: 'intruder' },
    headers: { Authorization: `Token ${joinKey}` },
  });
  assert.equal(malformed.status, 401);

  const roster = await call<{ agents: { name: string }[] }>(h, 'GET', '/v1/agents', { token: h.operatorToken });
  assert.ok(!roster.json.agents.some((a) => a.name === 'intruder'), 'no rejected join may leave a row behind');
});

test('rotating the join key kills the old one instantly and spares existing agents', async () => {
  const veteran = await join('veteran');

  const rotated = await call<{ join_key: string }>(h, 'POST', '/v1/join-key/rotate', {
    token: h.operatorToken,
    body: {},
  });
  assert.equal(rotated.status, 200);
  assert.match(rotated.json.join_key, /^sw_j_[0-9a-f]{32}$/);
  assert.notEqual(rotated.json.join_key, joinKey);
  const oldKey = joinKey;
  joinKey = rotated.json.join_key;

  const withOldKey = await call(h, 'POST', '/v1/join', { token: oldKey, body: { name: 'too-late' } });
  assert.equal(withOldKey.status, 401, 'the rotated key must stop working immediately');

  const withNewKey = await join('right-on-time');
  assert.equal(withNewKey.agent, 'right-on-time');

  assert.equal(await currentName(veteran.token), 'veteran', 'rotation must not disturb enrolled agents');

  const shown = await call<{ join_key: string }>(h, 'GET', '/v1/join-key', { token: h.operatorToken });
  assert.equal(shown.json.join_key, joinKey);

  const forAgent = await call(h, 'POST', '/v1/join-key/rotate', { token: veteran.token, body: {} });
  assert.equal(forAgent.status, 403);
});

// ----------------------------------------------------------------- rename

test('rename: the agent re-learns its name, history follows, the line records it', async () => {
  const a = await join('renamer-a');
  const b = await join('renamer-b');
  await createChannel('rename-history', ['renamer-a', 'renamer-b']);
  await send(a.token, 'rename-history', { subject: 'before the rename', body: 'attribute me correctly' });

  const before = await call<{ line_seq: number }>(h, 'GET', '/v1/agents/me', { token: a.token });
  const cursor = before.json.line_seq;
  const line = await FrameLog.open(h, `/v1/agents/me/line?token=${a.token}&since=${cursor}`);
  try {
    const res = await call<{ old: string; name: string }>(h, 'POST', '/v1/agents/renamer-a/rename', {
      token: h.operatorToken,
      body: { name: 'renamer-z' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.deepEqual(res.json, { old: 'renamer-a', name: 'renamer-z' });

    // (a) the agent re-learns its name from its own token.
    assert.equal(await currentName(a.token), 'renamer-z');

    // (b) history written BEFORE the rename now attributes to the new name:
    // messages carry sender_id, and every read resolves it fresh.
    const history = await call<{ messages: any[] }>(h, 'GET', '/v1/channels/rename-history/messages?since=0', {
      token: b.token,
    });
    assert.equal(history.json.messages[0].sender, 'renamer-z');

    // (c) a persisted `renamed` frame arrives live...
    const frame = await line.next();
    assert.equal(frame.type, 'renamed');
    assert.equal(frame.old, 'renamer-a');
    assert.equal(frame.new, 'renamer-z');
    assert.equal(frame.line_seq, cursor + 1);

    // ...and replays for a socket that was not there for it.
    const replay = await FrameLog.open(h, `/v1/agents/me/line?token=${a.token}&since=${cursor}`);
    try {
      assert.deepEqual(await replay.next(), frame);
    } finally {
      replay.close();
    }

    // Membership lists and the roster speak the new name only.
    const channel = await call<{ members: string[] }>(h, 'GET', '/v1/channels/rename-history', { token: b.token });
    assert.deepEqual(channel.json.members, ['renamer-b', 'renamer-z']);
  } finally {
    line.close();
  }
});

test('rename conflicts are loud: 409 taken, 400 same name, 404 unknown', async () => {
  const taken = await call(h, 'POST', '/v1/agents/renamer-b/rename', {
    token: h.operatorToken,
    body: { name: 'alpha' },
  });
  assert.equal(taken.status, 409, 'a rename is never deduped — the operator meant that exact name');
  assert.match(taken.json.error, /already exists/);

  // 'ghost' was deleted (and immediately re-taken by a fresh join above), so
  // renaming onto it collides with the LIVE holder — deleted names are free,
  // held names are not.
  const heldAgain = await call(h, 'POST', '/v1/agents/renamer-b/rename', {
    token: h.operatorToken,
    body: { name: 'ghost' },
  });
  assert.equal(heldAgain.status, 409);
  assert.match(heldAgain.json.error, /already exists/);

  const same = await call(h, 'POST', '/v1/agents/renamer-b/rename', {
    token: h.operatorToken,
    body: { name: 'renamer-b' },
  });
  assert.equal(same.status, 400);
  assert.match(same.json.error, /already named/);

  const unknown = await call(h, 'POST', '/v1/agents/no-such-agent/rename', {
    token: h.operatorToken,
    body: { name: 'whoever' },
  });
  assert.equal(unknown.status, 404);

  const badName = await call(h, 'POST', '/v1/agents/renamer-b/rename', {
    token: h.operatorToken,
    body: { name: 'Not A Slug' },
  });
  assert.equal(badName.status, 400);

  const asAgent = await call(h, 'POST', '/v1/agents/renamer-b/rename', {
    token: (await join('nosy')).token,
    body: { name: 'usurper' },
  });
  assert.equal(asAgent.status, 403);

  // Nothing above may have half-applied.
  const roster = await call<{ agents: { name: string }[] }>(h, 'GET', '/v1/agents', { token: h.operatorToken });
  assert.ok(roster.json.agents.some((a) => a.name === 'renamer-b'));
});

test('rename mid-connection: push filtering and echo suppression survive without a reconnect', async () => {
  const a = await join('live-a');
  const b = await join('live-b');
  await createChannel('rename-live', ['live-a', 'live-b']);

  const aWs = await FrameLog.open(h, `/v1/channels/rename-live/ws?token=${a.token}&since=0`);
  const bWs = await FrameLog.open(h, `/v1/channels/rename-live/ws?token=${b.token}&since=0`);
  try {
    const res = await call(h, 'POST', '/v1/agents/live-b/rename', {
      token: h.operatorToken,
      body: { name: 'live-b-renamed' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));

    // The old name is gone from the membership list, so it cannot be addressed.
    const staleTo = await call(h, 'POST', '/v1/channels/rename-live/messages', {
      token: a.token,
      body: { subject: 's', body: 'b', to: ['live-b'] },
    });
    assert.equal(staleTo.status, 400);

    // The NEW name reaches b's existing socket: the hub repointed it in place.
    const addressed = await send(a.token, 'rename-live', {
      subject: 'to the new name',
      body: 'no reconnect required',
      to: ['live-b-renamed'],
    });
    const received = await bWs.next();
    assert.equal(received.type, 'message');
    assert.equal(received.message.seq, addressed.seq);
    assert.equal(received.message.sender, 'live-a');

    // b's own send is still not echoed to b — suppression matches on agent id,
    // which a rename cannot move.
    const fromB = await send(b.token, 'rename-live', { subject: 'b speaks', body: 'under a new name' });
    const atA = await aWs.next();
    assert.equal(atA.message.seq, fromB.seq);
    assert.equal(atA.message.sender, 'live-b-renamed');

    await bWs.expectSilence(250);
    assert.equal(bWs.frames.length, 1, 'b must be woken only by the message addressed to it');
    await aWs.expectSilence(250);
    assert.equal(aWs.frames.length, 1, 'a must be woken only by b');
  } finally {
    aWs.close();
    bWs.close();
  }
});
