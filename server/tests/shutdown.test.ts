/**
 * The graceful shutdown sequence (SPEC §5a): stdin {"cmd":"shutdown"} makes
 * the server broadcast {"type":"shutdown"} on EVERY open socket, close them,
 * checkpoint SQLite and exit 0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FrameLog, call, startServer } from './helpers';

test('shutdown broadcasts a frame on every open socket, then exits 0', async () => {
  const h = await startServer();
  try {
    const agent = await call<{ token: string }>(h, 'POST', '/v1/agents', {
      token: h.operatorToken,
      body: { name: 'closer' },
    });
    const token = agent.json.token;
    await call(h, 'POST', '/v1/channels', {
      token: h.operatorToken,
      body: { name: 'goodbye', members: ['closer'] },
    });

    const line = await FrameLog.open(h, `/v1/agents/me/line?token=${token}&since=99`);
    const channel = await FrameLog.open(h, `/v1/channels/goodbye/ws?token=${token}&since=0`);
    const operator = await FrameLog.open(h, `/v1/channels/goodbye/ws?token=${h.operatorToken}&since=0`);

    h.child.stdin.write('{"cmd":"shutdown"}\n');

    for (const log of [line, channel, operator]) {
      const frame = await log.next();
      assert.deepEqual(frame, { type: 'shutdown' });
      const info = await log.closeInfo;
      assert.equal(info.code, 1001);
    }

    const code = await h.exited;
    assert.equal(code, 0, 'graceful shutdown must exit 0');

    // WAL was checkpointed into the main database file.
    const dbFile = path.join(h.dataDir, 'switchboard.db');
    assert.ok(fs.existsSync(dbFile));
    assert.ok(fs.statSync(dbFile).size > 0);
  } finally {
    h.kill();
    h.cleanup();
  }
});

test('unparseable and unknown stdin commands are reported, not obeyed', async () => {
  const h = await startServer();
  try {
    h.child.stdin.write('not json\n');
    h.child.stdin.write('{"cmd":"explode"}\n');
    await new Promise((resolve) => setTimeout(resolve, 300));

    const alive = await call(h, 'GET', '/v1/version');
    assert.equal(alive.status, 200, 'server must still be running');
    assert.ok(
      h.stderr.some((l) => l.includes('unparseable stdin line')),
      `expected a loud complaint, got: ${h.stderr.join(' | ')}`,
    );
    assert.ok(h.stderr.some((l) => l.includes('unknown stdin command')));

    const code = await h.stop();
    assert.equal(code, 0);
  } finally {
    h.kill();
    h.cleanup();
  }
});

test('in-flight long-polls settle immediately on shutdown — nothing dangles', async () => {
  const h = await startServer();
  try {
    const agent = await call<{ token: string }>(h, 'POST', '/v1/agents', {
      token: h.operatorToken,
      body: { name: 'poller' },
    });
    const token = agent.json.token;
    await call(h, 'POST', '/v1/channels', {
      token: h.operatorToken,
      body: { name: 'quiet', members: ['poller'] },
    });

    // Two 30-second long-polls with nothing to report: one on the control
    // line, one on the channel. Shutdown must resolve them right away —
    // a settled response or a closed connection both count; hanging for the
    // full wait does not.
    const started = Date.now();
    const pending = [
      call(h, 'GET', '/v1/agents/me/line?since=0&wait=30', { token }).catch(() => 'connection-closed'),
      call(h, 'GET', '/v1/channels/quiet/messages?since=0&wait=30', { token }).catch(() => 'connection-closed'),
    ];
    await new Promise((resolve) => setTimeout(resolve, 250));

    h.child.stdin.write('{"cmd":"shutdown"}\n');
    await Promise.all(pending);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `long-polls should settle at shutdown, took ${elapsed}ms`);

    const code = await h.exited;
    assert.equal(code, 0, 'graceful shutdown must still exit 0 with polls in flight');
  } finally {
    h.kill();
    h.cleanup();
  }
});

test('stdin EOF (parent death) triggers graceful shutdown, no orphan', async () => {
  const h = await startServer();
  try {
    h.child.stdin.end();
    const code = await h.exited;
    assert.equal(code, 0, 'server must exit 0 when its stdin closes');
    assert.ok(
      h.stderr.some((l) => l.includes('stdin closed')),
      `expected the shutdown reason on stderr, got: ${h.stderr.join(' | ')}`,
    );
  } finally {
    h.kill();
    h.cleanup();
  }
});
