/**
 * Token minting and comparison.
 *
 * Agent tokens (`sw_a_` + 32 hex) are persisted as a SHA-256 hex hash only;
 * the plaintext is handed out exactly once. The join key (`sw_j_` + 32 hex) is
 * the one enrollment credential, stored plaintext so the console can
 * re-display it. The operator token (`sw_o_` + 32 hex) is ephemeral, per-boot
 * and in-memory only (ARCHITECTURE "Tokens").
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function mintAgentToken(): string {
  return `sw_a_${randomBytes(16).toString('hex')}`;
}

export function mintJoinKey(): string {
  return `sw_j_${randomBytes(16).toString('hex')}`;
}

export function mintOperatorToken(): string {
  return `sw_o_${randomBytes(16).toString('hex')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time compare of two tokens (length differences are not secret). */
export function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
