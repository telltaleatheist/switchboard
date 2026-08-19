/**
 * The single object every handler is given: persistence, live connections,
 * paths and the per-boot operator token.
 */

import type { Hub } from './hub';
import type { Store } from './store';

export const API_VERSION = 1;
export const SERVER_VERSION = '0.1.0';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** Idle-expiry threshold in days (SPEC §13: default 14). */
  idleDays: number;
  /** Idle sweep interval in ms (default hourly; lowered by tests). */
  sweepIntervalMs: number;
}

export interface Ctx {
  config: Config;
  store: Store;
  hub: Hub;
  archiveDir: string;
  /** Ephemeral, per-boot, in-memory only. Never persisted. */
  operatorToken: string;
}

export const MAX_BODY_BYTES = 1024 * 1024; // 1 MB, hard 413 above this
export const MAX_WAIT_SECONDS = 60;
export const MAX_SUBJECT_CHARS = 500;
export const MAX_BODY_CHARS = 512 * 1024;
export const MAX_SIGNAL_CHARS = 200;
export const MAX_NOTE_CHARS = 2000;
/** The operator's welcome text — long enough to set a tone, not a manual. */
export const MAX_WELCOME_CHARS = 4000;
/**
 * Attachments. A screenshot or a log excerpt travels; a video does not — this
 * is an evidence channel, not a file server, and every byte sits in the
 * operator's own data dir forever.
 */
export const MAX_BLOB_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
export const MAX_PURPOSE_CHARS = 2000;
