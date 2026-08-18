/**
 * Boot and shutdown. `startSwitchboard` wires database + hub + HTTP + WS and
 * returns a handle; `shutdown()` runs the graceful sequence from SPEC §5a:
 * broadcast `{"type":"shutdown"}`, close sockets, WAL-checkpoint, done.
 */

import type * as http from 'node:http';
import { checkpointAndClose, openDatabase, type Db } from './db';
import type { Config, Ctx } from './context';
import { Hub } from './hub';
import { createHttpServer } from './httpserver';
import { runIdleSweep } from './lifecycle';
import { ROUTES } from './routes';
import { Store } from './store';
import { mintOperatorToken } from './tokens';
import { attachWebSockets } from './wsserver';

export interface Switchboard {
  port: number;
  host: string;
  operatorToken: string;
  ctx: Ctx;
  httpServer: http.Server;
  shutdown(): Promise<void>;
}

const SHUTDOWN_GRACE_MS = 2000;

export async function startSwitchboard(config: Config): Promise<Switchboard> {
  const opened = openDatabase(config.dataDir);
  const db: Db = opened.db;
  const ctx: Ctx = {
    config,
    store: new Store(db),
    hub: new Hub(),
    archiveDir: opened.archiveDir,
    operatorToken: mintOperatorToken(),
  };

  // The join key survives restarts (unlike the operator token): mint it on
  // first boot, reuse it forever after, until the operator rotates it.
  ctx.store.ensureJoinKey();

  const httpServer = createHttpServer(ctx, ROUTES);
  const ws = attachWebSockets(ctx, httpServer);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(config.port, config.host, () => {
      httpServer.removeListener('error', onError);
      resolve();
    });
  });

  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('http server did not bind to a TCP port');
  }

  // Catch up on channels that went idle while the switchboard was down, then
  // sweep on a timer.
  sweep(ctx);
  const sweepTimer = setInterval(() => sweep(ctx), config.sweepIntervalMs);
  sweepTimer.unref();

  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(sweepTimer);
    ctx.hub.broadcastShutdown();
    ws.stop();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        httpServer.closeAllConnections();
        resolve();
      }, SHUTDOWN_GRACE_MS);
      timer.unref();
      httpServer.close(() => {
        clearTimeout(timer);
        resolve();
      });
      httpServer.closeIdleConnections();
    });
    checkpointAndClose(db);
  };

  return {
    port: address.port,
    host: config.host,
    operatorToken: ctx.operatorToken,
    ctx,
    httpServer,
    shutdown,
  };
}

function sweep(ctx: Ctx): void {
  try {
    const closed = runIdleSweep(ctx);
    for (const name of closed) {
      process.stderr.write(`switchboard: closed idle channel '${name}' after ${ctx.config.idleDays} day(s)\n`);
    }
  } catch (err) {
    process.stderr.write(`switchboard: idle sweep failed: ${(err as Error).message}\n`);
  }
}
