/**
 * The hand-rolled router: exact method + segment match, `{param}` captures.
 * No framework, no middleware stack — a table and a loop.
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { Principal } from './auth';
import type { Ctx } from './context';

export interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** Decoded, strictly-UTF-8 request body text ('' when there was no body). */
  bodyText: string;
  principal: Principal;
}

export interface Result {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /**
   * Set ONLY by handlers that serve something other than JSON (today: the
   * skill file, as markdown). When present, `body` must be a string and is
   * written verbatim under this Content-Type instead of being JSON-encoded.
   */
  contentType?: string;
}

export type Handler = (ctx: Ctx, req: Req) => Result | Promise<Result>;

export type AuthMode = 'none' | 'agent' | 'operator' | 'any';

export interface Route {
  method: string;
  pattern: string;
  auth: AuthMode;
  handler: Handler;
}

export interface Matched {
  route: Route;
  params: Record<string, string>;
}

export function matchRoute(routes: readonly Route[], method: string, path: string): Matched | 'method-not-allowed' | null {
  const parts = splitPath(path);
  let pathMatchedOtherMethod = false;

  for (const route of routes) {
    const patternParts = splitPath(route.pattern);
    if (patternParts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < patternParts.length; i++) {
      const p = patternParts[i] as string;
      const actual = parts[i] as string;
      if (p.startsWith('{') && p.endsWith('}')) {
        params[p.slice(1, -1)] = decodeURIComponent(actual);
      } else if (p !== actual) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (route.method !== method) {
      pathMatchedOtherMethod = true;
      continue;
    }
    return { route, params };
  }

  return pathMatchedOtherMethod ? 'method-not-allowed' : null;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}
