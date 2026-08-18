/**
 * Small shared helpers: server time, strict UTF-8 decoding, and the strict
 * field validators every request body goes through.
 */

import { badRequest } from './errors';

/** ISO-8601 UTC with milliseconds. Server clock is THE clock (SPEC §2). */
export function nowIso(): string {
  return new Date().toISOString();
}

export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

const strictDecoder = new TextDecoder('utf-8', { fatal: true });

/** Decode bytes as strict UTF-8; invalid sequences fail loudly with a 400. */
export function decodeUtf8Strict(buf: Buffer, what: string): string {
  try {
    return strictDecoder.decode(buf);
  } catch {
    throw badRequest(`${what} is not valid UTF-8`);
  }
}

/** Channel and agent names are slugs: lowercase alnum plus '-' and '_'. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertSlug(value: unknown, field: string): string {
  if (typeof value !== 'string') throw badRequest(`field '${field}' must be a string`);
  if (!SLUG_RE.test(value)) {
    throw badRequest(
      `field '${field}' must be a slug: lowercase letters, digits, '-' or '_', 1-64 chars, starting alphanumeric (got '${value}')`,
    );
  }
  return value;
}

/** Reject any top-level field the endpoint does not know about (SPEC §6). */
export function assertNoUnknownFields(obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw badRequest(`unknown field '${key}' (allowed: ${allowed.join(', ')})`);
    }
  }
}

export function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(obj: Record<string, unknown>, field: string, maxLen: number): string {
  const value = obj[field];
  if (value === undefined || value === null) throw badRequest(`missing required field '${field}'`);
  if (typeof value !== 'string') throw badRequest(`field '${field}' must be a string`);
  if (value.length === 0) throw badRequest(`field '${field}' must not be empty`);
  if (value.length > maxLen) throw badRequest(`field '${field}' exceeds ${maxLen} characters`);
  return value;
}

export function optionalString(obj: Record<string, unknown>, field: string, maxLen: number): string | null {
  if (!(field in obj) || obj[field] === undefined || obj[field] === null) return null;
  const value = obj[field];
  if (typeof value !== 'string') throw badRequest(`field '${field}' must be a string`);
  if (value.length === 0) throw badRequest(`field '${field}' must not be empty`);
  if (value.length > maxLen) throw badRequest(`field '${field}' exceeds ${maxLen} characters`);
  return value;
}

export function optionalStringArray(obj: Record<string, unknown>, field: string): string[] | null {
  if (!(field in obj) || obj[field] === undefined || obj[field] === null) return null;
  return requireStringArray(obj, field);
}

export function requireStringArray(obj: Record<string, unknown>, field: string): string[] {
  const value = obj[field];
  if (value === undefined || value === null) throw badRequest(`missing required field '${field}'`);
  if (!Array.isArray(value)) throw badRequest(`field '${field}' must be an array of strings`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw badRequest(`field '${field}' must contain only non-empty strings`);
    }
    if (out.includes(entry)) throw badRequest(`field '${field}' contains duplicate entry '${entry}'`);
    out.push(entry);
  }
  return out;
}

export function optionalPositiveInt(obj: Record<string, unknown>, field: string): number | null {
  if (!(field in obj) || obj[field] === undefined || obj[field] === null) return null;
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw badRequest(`field '${field}' must be a positive integer`);
  }
  return value;
}

export function requireNonNegativeInt(obj: Record<string, unknown>, field: string): number {
  const value = obj[field];
  if (value === undefined || value === null) throw badRequest(`missing required field '${field}'`);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw badRequest(`field '${field}' must be a non-negative integer`);
  }
  return value;
}

/** Parse a query-string integer, failing loudly on anything non-numeric. */
export function queryInt(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw badRequest(`query parameter '${name}' must be a non-negative integer (got '${raw}')`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw badRequest(`query parameter '${name}' is out of range`);
  return parsed;
}

export function assertNoUnknownQuery(params: URLSearchParams, allowed: readonly string[]): void {
  for (const key of params.keys()) {
    if (!allowed.includes(key)) {
      throw badRequest(`unknown query parameter '${key}' (allowed: ${allowed.join(', ') || 'none'})`);
    }
  }
}
