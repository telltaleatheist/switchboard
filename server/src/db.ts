/**
 * SQLite open + schema. WAL mode, foreign keys on, schema_version in `meta`.
 * The schema is exactly the one in ARCHITECTURE.md "SQLite schema".
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type Db = Database.Database;

export const SCHEMA_VERSION = '3';
export const DB_FILENAME = 'switchboard.db';
export const ARCHIVE_DIRNAME = 'archives';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  line_seq     INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS channels (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at  TEXT,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  note       TEXT
);

-- A channel name is unique among OPEN channels only; closed names are reusable.
CREATE UNIQUE INDEX IF NOT EXISTS channels_open_name
  ON channels(name) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  joined_at  TEXT NOT NULL,
  UNIQUE(channel_id, agent_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  ts          TEXT NOT NULL,
  sender_id   INTEGER NOT NULL REFERENCES agents(id),
  to_json     TEXT,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  in_reply_to INTEGER,
  signal      TEXT,
  state       TEXT,
  UNIQUE(channel_id, seq)
);

CREATE TABLE IF NOT EXISTS line_events (
  id         INTEGER PRIMARY KEY,
  agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  ts         TEXT NOT NULL,
  frame_json TEXT NOT NULL,
  UNIQUE(agent_id, seq)
);

CREATE TABLE IF NOT EXISTS idempotency (
  key         TEXT NOT NULL,
  agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  result_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(key, agent_id)
);

CREATE TABLE IF NOT EXISTS patch_requests (
  id           INTEGER PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  with_json    TEXT NOT NULL,
  purpose      TEXT NOT NULL,
  status       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archives (
  id           INTEGER PRIMARY KEY,
  channel_name TEXT NOT NULL,
  closed_at    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  transcript   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_channel_seq ON messages(channel_id, seq);
CREATE INDEX IF NOT EXISTS line_events_agent_seq ON line_events(agent_id, seq);
`;

export interface OpenedDb {
  db: Db;
  dbPath: string;
  archiveDir: string;
}

/** Open (creating if needed) the switchboard database inside dataDir. */
export function openDatabase(dataDir: string): OpenedDb {
  fs.mkdirSync(dataDir, { recursive: true });
  const archiveDir = path.join(dataDir, ARCHIVE_DIRNAME);
  fs.mkdirSync(archiveDir, { recursive: true });

  const dbPath = path.join(dataDir, DB_FILENAME);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  const existing = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  if (existing === undefined) {
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
  } else if (existing.value !== SCHEMA_VERSION) {
    migrate(db, existing.value, dbPath);
  }

  return { db, dbPath, archiveDir };
}

/**
 * Stepwise migration ladder. Each entry upgrades FROM its key version to the
 * next. Unknown (newer) versions still fail loudly — downgrades are refused.
 */
const MIGRATIONS: Record<string, (db: Db) => string> = {
  '1': (db) => {
    db.exec('ALTER TABLE agents ADD COLUMN deleted_at TEXT');
    return '2';
  },
  '2': (db) => {
    db.exec('ALTER TABLE agents ADD COLUMN last_seen_at TEXT');
    return '3';
  },
};

function migrate(db: Db, fromVersion: string, dbPath: string): void {
  let version = fromVersion;
  const apply = db.transaction(() => {
    while (version !== SCHEMA_VERSION) {
      const step = MIGRATIONS[version];
      if (!step) {
        throw new Error(
          `database at ${dbPath} has schema_version ${version}, this server speaks ${SCHEMA_VERSION} and has no migration path`,
        );
      }
      version = step(db);
    }
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(SCHEMA_VERSION, 'schema_version');
  });
  try {
    apply();
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Flush the WAL into the main database file — part of graceful shutdown. */
export function checkpointAndClose(db: Db): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}
