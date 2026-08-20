/**
 * SQLite open + schema. WAL mode, foreign keys on, schema_version in `meta`.
 * The schema is exactly the one in ARCHITECTURE.md "SQLite schema".
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type Db = Database.Database;

export const SCHEMA_VERSION = '7';
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
  -- Attribution snapshot: kept current by renames while the sender lives,
  -- frozen when it is deleted — which is what lets deletion free the name.
  sender_name TEXT,
  to_json     TEXT,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  in_reply_to INTEGER,          -- legacy scalar: first cited seq
  reply_to_json TEXT,           -- JSON array of every cited seq, NULL = none
  wake        INTEGER NOT NULL DEFAULT 1,  -- 0 = record-only, 1 = wake, 2 = digest
  attachments_json TEXT,        -- JSON array of blob ids, NULL = none
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
  -- The closed channel's row id. Its messages are never deleted, so this is
  -- what lets the console render an archive as cards rather than markdown.
  channel_id   INTEGER,
  channel_name TEXT NOT NULL,
  closed_at    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  transcript   TEXT NOT NULL
);

-- Content-addressed attachments: the bytes live in <dataDir>/blobs/<id>,
-- this table is what the API can describe without touching the filesystem.
-- id IS the sha256 of the bytes, so an identical upload costs nothing twice.
CREATE TABLE IF NOT EXISTS blobs (
  id         TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  name       TEXT,
  created_at TEXT NOT NULL
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
  '3': (db) => {
    // Attribution moves to a per-message snapshot so deleting an agent can
    // free its name. Backfill from the rows that still resolve, then mangle
    // every existing tombstone's name (they only existed to keep the FK and
    // the name squatted — the squatting is exactly what this removes).
    db.exec('ALTER TABLE messages ADD COLUMN sender_name TEXT');
    db.exec('UPDATE messages SET sender_name = (SELECT name FROM agents WHERE agents.id = messages.sender_id)');
    db.exec("UPDATE agents SET name = '#gone-' || id WHERE deleted_at IS NOT NULL");
    return '4';
  },
  '4': (db) => {
    // Multi-citation replies + record-only sends (first-users RFC).
    db.exec('ALTER TABLE messages ADD COLUMN reply_to_json TEXT');
    db.exec('UPDATE messages SET reply_to_json = json_array(in_reply_to) WHERE in_reply_to IS NOT NULL');
    db.exec('ALTER TABLE messages ADD COLUMN wake INTEGER NOT NULL DEFAULT 1');
    return '5';
  },
  '6': (db) => {
    // Archives learn their channel id. Old rows keep NULL: their transcript is
    // still there, they simply cannot be re-rendered as cards.
    db.exec('ALTER TABLE archives ADD COLUMN channel_id INTEGER');
    db.exec(
      "UPDATE archives SET channel_id = (SELECT c.id FROM channels c" +
        " WHERE c.name = archives.channel_name AND c.closed_at = archives.closed_at)",
    );
    return '7';
  },
  '5': (db) => {
    // Attachments: evidence travels instead of descriptions of evidence.
    // The blobs table is created by SCHEMA_SQL on every open, so this only
    // has to add the message column.
    db.exec('ALTER TABLE messages ADD COLUMN attachments_json TEXT');
    return '6';
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
