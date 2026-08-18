/**
 * Authentication. `Authorization: Bearer <token>` on REST, `?token=` on WS
 * (Monitor can only pass a URL). 401 = unknown/bad token, 403 = valid token
 * but wrong scope.
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { Ctx } from './context';
import { forbidden, unauthorized } from './errors';
import type { AgentRow } from './store';
import { hashToken, tokensEqual } from './tokens';

export type Principal =
  | { kind: 'none' }
  | { kind: 'operator'; token: string }
  | { kind: 'agent'; agent: AgentRow; token: string };

export function principalFromToken(ctx: Ctx, token: string): Principal {
  if (token.length === 0) throw unauthorized('empty token');
  if (token.startsWith('sw_o_')) {
    if (!tokensEqual(token, ctx.operatorToken)) throw unauthorized('unknown or expired operator token');
    return { kind: 'operator', token };
  }
  const agent = ctx.store.findAgentByTokenHash(hashToken(token));
  if (!agent) throw unauthorized('unknown token');
  return { kind: 'agent', agent, token };
}

export function principalFromHeaders(ctx: Ctx, headers: IncomingHttpHeaders): Principal {
  const raw = headers['authorization'];
  if (raw === undefined) throw unauthorized("missing Authorization header (expected 'Bearer <token>')");
  if (Array.isArray(raw)) throw unauthorized('multiple Authorization headers');
  const match = /^Bearer (.+)$/.exec(raw.trim());
  if (!match) throw unauthorized("malformed Authorization header (expected 'Bearer <token>')");
  return principalFromToken(ctx, (match[1] as string).trim());
}

/**
 * The enrollment credential check for POST /v1/join. The join key names nobody
 * and can read nothing, so it is not a Principal: that route carries auth
 * 'none' and calls this instead. Anything that is not the CURRENT join key —
 * an agent token, the operator token, a rotated key — is 401, because only the
 * join key enrolls (ARCHITECTURE "Tokens").
 */
export function requireJoinKey(ctx: Ctx, headers: IncomingHttpHeaders): void {
  const raw = headers['authorization'];
  if (raw === undefined) throw unauthorized("missing Authorization header (expected 'Bearer sw_j_<join key>')");
  if (Array.isArray(raw)) throw unauthorized('multiple Authorization headers');
  const match = /^Bearer (.+)$/.exec(raw.trim());
  if (!match) throw unauthorized("malformed Authorization header (expected 'Bearer sw_j_<join key>')");
  if (!tokensEqual((match[1] as string).trim(), ctx.store.getJoinKey())) {
    throw unauthorized('unknown or rotated join key; POST /v1/join accepts only the current join key');
  }
}

export function requireOperator(principal: Principal): void {
  if (principal.kind !== 'operator') throw forbidden('this endpoint requires the operator token');
}

export function requireAgent(principal: Principal): AgentRow {
  if (principal.kind !== 'agent') throw forbidden('this endpoint requires an agent token');
  return principal.agent;
}
