import type { Database } from "better-sqlite3";

/**
 * Idempotent SQLite DDL for the M1 auth tables and the M2 `channels`/`messages`
 * tables (SPEC.md §8). Run on every {@link ./db.ts openDatabase} so a fresh
 * deploy or a repeated startup converges to the same schema. The M3
 * `attachments` table (SPEC.md §8) lands in this schema.
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
  disabled INTEGER NOT NULL DEFAULT 0,
  -- avatar_attachment_id: nullable FK → attachments(id), the user's current
  -- profile picture (an unlinked, message_id-NULL attachment). Forward reference
  -- is fine (SQLite resolves FK targets lazily within a single db.exec, same as
  -- messages.attachment_id). Existing M1+ databases predate this column, so
  -- applySchema() backfills it via ALTER TABLE (see migrate()).
  avatar_attachment_id INTEGER REFERENCES attachments(id)
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
  -- attachment_id: nullable FK → attachments(id) (declared below; SQLite
  -- resolves FK targets lazily within a single db.exec, so the forward
  -- reference is fine). NOTE: a pre-existing M2 database already has this
  -- table, so CREATE TABLE IF NOT EXISTS is a no-op there and the column
  -- stays FK-less (SQLite cannot ALTER ... ADD CONSTRAINT) — integrity is
  -- enforced in the accessor/gateway layer (link-once + ownership checks).
  attachment_id INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id),
  FOREIGN KEY (author_id) REFERENCES users(id),
  FOREIGN KEY (attachment_id) REFERENCES attachments(id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER,
  uploader_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id),
  FOREIGN KEY (uploader_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_invite_tokens_token_hash ON invite_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
`;

/** True if `column` exists on `table` (via PRAGMA table_info). `table` is a trusted
 * literal here, never user input, so interpolating it into the pragma is safe. */
function columnExists(db: Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/**
 * Additive, idempotent migrations for columns the original `CREATE TABLE IF NOT
 * EXISTS` can't backfill (SQLite has no `ADD COLUMN IF NOT EXISTS`). Each step is
 * guarded by a column-existence check so it runs once on legacy databases and is a
 * no-op on fresh ones (which already get the column from SCHEMA_SQL).
 */
function migrate(db: Database): void {
  if (!columnExists(db, "users", "avatar_attachment_id")) {
    // Default NULL — required for ALTER TABLE ... ADD COLUMN with a REFERENCES clause.
    db.exec("ALTER TABLE users ADD COLUMN avatar_attachment_id INTEGER REFERENCES attachments(id)");
  }
}

/** Applies the M1/M2/M3 schema + additive migrations (idempotent). Safe to call on every open and from the CLI/tests. */
export function applySchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  migrate(db);
}
