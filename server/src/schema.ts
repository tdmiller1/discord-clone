import type { Database } from "better-sqlite3";

/**
 * Idempotent SQLite DDL for the M1 auth tables and the M2 `channels`/`messages`
 * tables (SPEC.md §8). Run on every {@link ./db.ts openDatabase} so a fresh
 * deploy or a repeated startup converges to the same schema. The `attachments`
 * table is still deferred to M3.
 *
 * Timestamps are stored as unix epoch milliseconds (`Date.now()`); booleans as
 * 0/1 integers.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invite_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  used_by INTEGER,
  used_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (used_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','voice')),
  position INTEGER NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  -- attachment_id: nullable, NO FOREIGN KEY. The 'attachments' table is M3;
  -- under PRAGMA foreign_keys = ON a FK to a missing table errors on open.
  -- The FK is added when 'attachments' lands (M3).
  attachment_id INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id),
  FOREIGN KEY (author_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_invite_tokens_token_hash ON invite_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id, id);
`;

/** Applies the M1/M2 schema (idempotent). Safe to call on every open and from the CLI/tests. */
export function applySchema(db: Database): void {
  db.exec(SCHEMA_SQL);
}
