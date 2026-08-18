/**
 * The node:http request pipeline: read body (1 MB cap, strict UTF-8), match a
 * route, authenticate, run the handler, serialise the result. Every thrown
 * HttpError becomes `{"error": reason}` with its status; anything else is a
 * 500 that is also logged to stderr — nothing is swallowed.
 */

import * as http from 'node:http';
import { principalFromHeaders, requireAgent, requireOperator, type Principal } from './auth';
import { MAX_BODY_BYTES, type Ctx } from './context';
import { HttpError, badRequest, payloadTooLarge } from './errors';
import { matchRoute, type Req, type Result, type Route } from './router';
import { decodeUtf8Strict } from './util';

export function createHttpServer(ctx: Ctx, routes: readonly Route[]): http.Server {
  const server = http.createServer((req, res) => {
    // CORS: browser-origin callers are legitimate clients (the Electron
    // renderer and ng-serve dev UI are cross-origin to this server, and
    // browser-extension agents may join later). Auth is bearer-token, never
    // cookie-based, so a permissive origin policy exposes nothing a caller
    // without a token could use.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Idempotency-Replayed');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }
    handle(ctx, routes, req, res).catch((err: unknown) => {
      respondError(res, err);
    });
  });
  return server;
}

async function handle(
  ctx: Ctx,
  routes: readonly Route[],
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://switchboard.invalid');
  } catch {
    respondJson(res, 400, { error: 'malformed request URL' });
    return;
  }

  const matched = matchRoute(routes, req.method ?? 'GET', url.pathname);
  if (matched === null) {
    respondJson(res, 404, { error: `no such endpoint: ${req.method} ${url.pathname}` });
    return;
  }
  if (matched === 'method-not-allowed') {
    respondJson(res, 405, { error: `method ${req.method} not allowed on ${url.pathname}` });
    return;
  }

  let bodyText = '';
  try {
    const raw = await readBody(req);
    bodyText = raw.length === 0 ? '' : decodeUtf8Strict(raw, 'request body');
  } catch (err) {
    respondError(res, err);
    return;
  }

  let principal: Principal;
  try {
    principal = matched.route.auth === 'none' ? { kind: 'none' } : principalFromHeaders(ctx, req.headers);
    if (matched.route.auth === 'operator') requireOperator(principal);
    if (matched.route.auth === 'agent') requireAgent(principal);
  } catch (err) {
    respondError(res, err);
    return;
  }

  const request: Req = {
    method: req.method ?? 'GET',
    path: url.pathname,
    params: matched.params,
    query: url.searchParams,
    headers: req.headers,
    bodyText,
    principal,
  };

  try {
    const result: Result = await matched.route.handler(ctx, request);
    respondJson(res, result.status, result.body, result.headers);
  } catch (err) {
    respondError(res, err);
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    // Refuse an over-sized body before reading a byte when the client declared
    // its length; the streaming guard below covers chunked uploads.
    const declared = req.headers['content-length'];
    if (typeof declared === 'string' && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
      req.resume();
      reject(payloadTooLarge(`request body exceeds the ${MAX_BODY_BYTES} byte limit`));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        req.destroy();
        reject(payloadTooLarge(`request body exceeds the ${MAX_BODY_BYTES} byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(badRequest(`request stream failed: ${err.message}`));
    });
  });
}

export function respondJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  if (res.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    ...(headers ?? {}),
  });
  res.end(payload);
}

function respondError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    respondJson(res, err.status, { error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`switchboard: unhandled request error: ${message}\n`);
  if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
  respondJson(res, 500, { error: `internal server error: ${message}` });
}
