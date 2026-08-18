/**
 * Restart self-healing (SPEC §5a) and idle expiry (SPEC §5): state survives a
 * reboot, the operator token does not, and stale channels are swept closed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameLog, call, startServer, tempDataDir } from './helpers';
import { CliError, parseArgs } from '../src/cli';

test('agents, channels and messages survive a restart; the operator token does not', async () => {
  const dataDir = tempDataDir();
  const first = await startServer({ dataDir, keepDataDir: true });
  let token: string;
  let firstOperatorToken: string;
  try {
    firstOperatorToken = first.operatorToken;
    const agent = await call<{ token: string }>(first, 'POST', '/v1/agents', {
      token: first.operatorToken,
      body: { name: 'survivor' },
    });
    token = agent.json.token;
    await call(first, 'POST', '/v1/channels', {
      token: first.operatorToken,
      body: { name: 'persistent', members: ['survivor'] },
    });
    await call(first, 'POST', '/v1/channels/persistent/messages', {
      token,
      body: { subject: 'before the restart', body: 'still here?' },
    });
    assert.equal(await first.stop(), 0);
  } finally {
    first.kill();
  }

  const second = await startServer({ dataDir });
  try {
    assert.notEqual(second.operatorToken, firstOperatorToken, 'operator tokens are ephemeral per boot');
    const stale = await call(second, 'GET', '/v1/agents', { token: firstOperatorToken });
    assert.equal(stale.status, 401);

    const me = await call<any>(second, 'GET', '/v1/agents/me', { token });
    assert.equal(me.status, 200, 'the agent token still works after a restart');
    assert.equal(me.json.agent, 'survivor');
    assert.deepEqual(
      me.json.channels.map((c: any) => c.name),
      ['persistent'],
    );

    const replay = await call<{ messages: any[] }>(second, 'GET', '/v1/channels/persistent/messages?since=0', { token });
    assert.equal(replay.json.messages.length, 1);
    assert.equal(replay.json.messages[0].subject, 'before the restart');

    // The control line replays the pre-restart invitation from the cursor.
    const line = await FrameLog.open(second, `/v1/agents/me/line?token=${token}&since=0`);
    const frame = await line.next();
    assert.equal(frame.type, 'invite');
    assert.equal(frame.channel, 'persistent');
    assert.equal(frame.token, token);
    line.close();

    assert.equal(await second.stop(), 0);
  } finally {
    second.kill();
    second.cleanup();
  }
});

test('idle expiry closes stale channels and pushes an idle-expiry closure', async () => {
  const dataDir = tempDataDir();
  const first = await startServer({ dataDir, keepDataDir: true });
  let token: string;
  try {
    const agent = await call<{ token: string }>(first, 'POST', '/v1/agents', {
      token: first.operatorToken,
      body: { name: 'forgetful' },
    });
    token = agent.json.token;
    await call(first, 'POST', '/v1/channels', {
      token: first.operatorToken,
      body: { name: 'abandoned', members: ['forgetful'] },
    });
    await call(first, 'POST', '/v1/channels/abandoned/messages', {
      token,
      body: { subject: 'anybody there', body: 'hello?' },
    });
    assert.equal(await first.stop(), 0);
  } finally {
    first.kill();
  }

  // Boot with a zero-day idle threshold: the startup sweep closes it.
  const second = await startServer({ dataDir, idleDays: 0 });
  try {
    const open = await call<{ channels: any[] }>(second, 'GET', '/v1/channels?status=open', {
      token: second.operatorToken,
    });
    assert.deepEqual(open.json.channels, []);

    const archives = await call<{ archives: any[] }>(second, 'GET', '/v1/archives', { token: second.operatorToken });
    const archive = archives.json.archives.find((a) => a.channel_name === 'abandoned');
    assert.ok(archive, 'the swept channel should be archived');
    assert.equal(archive.reason, 'idle-expiry');

    const line = await FrameLog.open(second, `/v1/agents/me/line?token=${token}&since=1`);
    const frame = await line.next();
    assert.equal(frame.type, 'closed');
    assert.equal(frame.channel, 'abandoned');
    assert.equal(frame.reason, 'idle-expiry');
    assert.match(frame.transcript, /anybody there/);
    line.close();

    assert.equal(await second.stop(), 0);
  } finally {
    second.kill();
    second.cleanup();
  }
});

test('the CLI refuses to start without its three required flags', () => {
  assert.throws(() => parseArgs(['--host', '127.0.0.1', '--data-dir', 'x']), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.match((err as Error).message, /--port/);
    return true;
  });
  assert.throws(() => parseArgs(['--port', '1', '--data-dir', 'x']), CliError);
  assert.throws(() => parseArgs(['--port', '1', '--host', 'h']), CliError);
  assert.throws(() => parseArgs(['--port', 'abc', '--host', 'h', '--data-dir', 'x']), CliError);
  assert.throws(() => parseArgs(['--port', '1', '--host', 'h', '--data-dir', 'x', '--wat', '1']), CliError);

  const config = parseArgs(['--port', '4400', '--host', '0.0.0.0', '--data-dir', 'somewhere']);
  assert.equal(config.port, 4400);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.idleDays, 14);
});
