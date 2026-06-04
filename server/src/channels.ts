import type { Db } from "./db.js";
import type { ChannelRow, MessageRow } from "./types.js";

/**
 * Single source of truth for channel + message persistence (SPEC.md §8/§9).
 * Framework-agnostic accessors built on the `Db` handle — every function takes
 * `db` as its first argument (mirroring {@link ./auth.ts authenticateSession}),
 * so both the WS gateway (story 002) and the REST API (story 003) call them with
 * the shared `app.db`/gateway handle and no second connection is opened.
 *
 * Write accessors re-`SELECT` the inserted row by `lastInsertRowid` and return
 * the full `*Row`, so callers can map to the public shape and broadcast without a
 * second round-trip.
 */

/** Inserts a channel and returns the persisted row. */
export function createChannel(
  db: Db,
  input: {
    name: string;
    type: "text" | "voice";
    position: number;
    createdBy: number | null;
  },
): ChannelRow {
  const insert = db
    .prepare(
      "INSERT INTO channels (name, type, position, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(input.name, input.type, input.position, input.createdBy, Date.now());
  return db
    .prepare("SELECT * FROM channels WHERE id = ?")
    .get(Number(insert.lastInsertRowid)) as ChannelRow;
}

/** Looks up a single channel by id, or `undefined` if it does not exist. */
export function getChannelById(db: Db, id: number): ChannelRow | undefined {
  return db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as
    | ChannelRow
    | undefined;
}

/** Lists every channel, ordered by `position` then `id`. */
export function listChannels(db: Db): ChannelRow[] {
  return db
    .prepare("SELECT * FROM channels ORDER BY position, id")
    .all() as ChannelRow[];
}

/** Inserts a message and returns the persisted row. */
export function insertMessage(
  db: Db,
  input: {
    channelId: number;
    authorId: number;
    content: string;
    attachmentId: number | null;
  },
): MessageRow {
  const insert = db
    .prepare(
      "INSERT INTO messages (channel_id, author_id, content, attachment_id, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      input.channelId,
      input.authorId,
      input.content,
      input.attachmentId,
      Date.now(),
    );
  return db
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(Number(insert.lastInsertRowid)) as MessageRow;
}

/**
 * Keyset history page for a channel, newest-first (`ORDER BY id DESC`). When
 * `before` is a finite number, only rows with `id < before` are returned (the
 * exclusive cursor), so the caller can page backwards. `limit` is used as-given;
 * callers resolve it via {@link clampHistoryLimit} first. The
 * `idx_messages_channel_id` index on `(channel_id, id)` covers this query.
 */
export function getChannelMessages(
  db: Db,
  channelId: number,
  opts: { before?: number; limit: number },
): MessageRow[] {
  if (opts.before !== undefined && Number.isFinite(opts.before)) {
    return db
      .prepare(
        "SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
      )
      .all(channelId, opts.before, opts.limit) as MessageRow[];
  }
  return db
    .prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?")
    .all(channelId, opts.limit) as MessageRow[];
}

/**
 * Resolves a requested page size against the configured bounds: undefined,
 * non-finite, or `<= 0` requests fall back to `defaultLimit`; everything else is
 * capped at `maxLimit`. Shared so callers (story 003's `?limit=`, story 002) clamp
 * consistently before passing the value to {@link getChannelMessages}.
 */
export function clampHistoryLimit(
  requested: number | undefined,
  opts: { defaultLimit: number; maxLimit: number },
): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return opts.defaultLimit;
  }
  return Math.min(requested, opts.maxLimit);
}
