import type { Db } from "./db.js";
import type { AttachmentRow, ChannelRow, MessageRow } from "./types.js";

/** A message read together with its embedded attachment (or `null`). */
export type MessageWithAttachment = {
  message: MessageRow;
  attachment: AttachmentRow | null;
};

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

/**
 * Normalizes a channel name to the Discord-style rule: trimmed, with every run of
 * whitespace collapsed to a single hyphen so a channel name never contains spaces
 * (SPEC.md §9). The server is authoritative — the client mirrors this for live
 * feedback, but this is what actually gets persisted.
 */
export function normalizeChannelName(raw: string): string {
  return raw.trim().replace(/\s+/g, "-");
}

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

/**
 * Returns the next monotonic append `position` for a new channel: `MAX(position)
 * + 1`, or `0` when the table is empty. Keeps the `SELECT MAX(position)` inside
 * the data layer and yields a stable order consistent with {@link listChannels}'
 * `ORDER BY position, id` (reorder is an explicit non-goal).
 */
export function nextChannelPosition(db: Db): number {
  const row = db
    .prepare("SELECT MAX(position) AS maxPos FROM channels")
    .get() as { maxPos: number | null };
  return row.maxPos === null ? 0 : row.maxPos + 1;
}

/** Lists every channel, ordered by `position` then `id`. */
export function listChannels(db: Db): ChannelRow[] {
  return db
    .prepare("SELECT * FROM channels ORDER BY position, id")
    .all() as ChannelRow[];
}

/**
 * Returns the single seeded voice channel (the v1 single-room invariant
 * guarantees at most one, SPEC.md §13.3), or `undefined` before seeding. Doubles
 * as the typed `text` vs `voice` lookup and the story-003 single-room resolver.
 */
export function getVoiceChannel(db: Db): ChannelRow | undefined {
  return db
    .prepare("SELECT * FROM channels WHERE type = 'voice' ORDER BY position, id LIMIT 1")
    .get() as ChannelRow | undefined;
}

/**
 * Idempotently ensures exactly one `type:"voice"` channel exists and returns it
 * (the canonical voice row). CREATE-if-absent: a restart finds the existing row
 * via {@link getVoiceChannel} and inserts nothing, so a restart does not create a
 * second one. The seeded row is `{ name: "Voice", type: "voice", createdBy: null,
 * position: nextChannelPosition(db) }` (`null` creator reserved for system-seeded
 * channels). The check-then-insert is wrapped in a transaction so concurrent boot
 * writers cannot race a second insert.
 */
export function seedVoiceChannel(db: Db): ChannelRow {
  return db.transaction(() => {
    const existing = getVoiceChannel(db);
    if (existing !== undefined) {
      return existing;
    }
    return createChannel(db, {
      name: "Voice",
      type: "voice",
      position: nextChannelPosition(db),
      createdBy: null,
    });
  })();
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
 * The shape of a `messages LEFT JOIN attachments` row: every `messages` column
 * plus the `attachments` columns aliased with an `a_` prefix (all NULL when the
 * message has no linked attachment). {@link splitMessageRow} divides it back into
 * a `MessageRow` and an `AttachmentRow | null`.
 */
type MessageJoinRow = MessageRow & {
  a_id: number | null;
  a_message_id: number | null;
  a_uploader_id: number | null;
  a_filename: string | null;
  a_content_type: string | null;
  a_size: number | null;
  a_width: number | null;
  a_height: number | null;
  a_path: string | null;
  a_created_at: number | null;
};

const MESSAGE_JOIN_COLUMNS =
  "m.id, m.channel_id, m.author_id, m.content, m.attachment_id, m.created_at, m.edited_at, " +
  "a.id AS a_id, a.message_id AS a_message_id, a.uploader_id AS a_uploader_id, " +
  "a.filename AS a_filename, a.content_type AS a_content_type, a.size AS a_size, " +
  "a.width AS a_width, a.height AS a_height, a.path AS a_path, a.created_at AS a_created_at";

/** Splits a `messages LEFT JOIN attachments` row into its message + attachment halves. */
function splitMessageRow(raw: MessageJoinRow): MessageWithAttachment {
  const message: MessageRow = {
    id: raw.id,
    channel_id: raw.channel_id,
    author_id: raw.author_id,
    content: raw.content,
    attachment_id: raw.attachment_id,
    created_at: raw.created_at,
    edited_at: raw.edited_at,
  };
  const attachment: AttachmentRow | null =
    raw.a_id === null
      ? null
      : {
          id: raw.a_id,
          message_id: raw.a_message_id,
          uploader_id: raw.a_uploader_id as number,
          filename: raw.a_filename as string,
          content_type: raw.a_content_type as string,
          size: raw.a_size as number,
          width: raw.a_width,
          height: raw.a_height,
          path: raw.a_path as string,
          created_at: raw.a_created_at as number,
        };
  return { message, attachment };
}

/**
 * Keyset history page for a channel, newest-first (`ORDER BY id DESC`). When
 * `before` is a finite number, only rows with `id < before` are returned (the
 * exclusive cursor), so the caller can page backwards. `limit` is used as-given;
 * callers resolve it via {@link clampHistoryLimit} first. The
 * `idx_messages_channel_id` index on `(channel_id, id)` covers this query.
 *
 * Each row is `LEFT JOIN`ed to `attachments` so the returned pair carries its
 * embedded attachment (or `null`) in a single round-trip — no N+1 per-row lookups.
 */
export function getChannelMessages(
  db: Db,
  channelId: number,
  opts: { before?: number; limit: number },
): MessageWithAttachment[] {
  if (opts.before !== undefined && Number.isFinite(opts.before)) {
    const rows = db
      .prepare(
        `SELECT ${MESSAGE_JOIN_COLUMNS} FROM messages m LEFT JOIN attachments a ON a.id = m.attachment_id WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`,
      )
      .all(channelId, opts.before, opts.limit) as MessageJoinRow[];
    return rows.map(splitMessageRow);
  }
  const rows = db
    .prepare(
      `SELECT ${MESSAGE_JOIN_COLUMNS} FROM messages m LEFT JOIN attachments a ON a.id = m.attachment_id WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT ?`,
    )
    .all(channelId, opts.limit) as MessageJoinRow[];
  return rows.map(splitMessageRow);
}

/**
 * Reads a single message with its embedded attachment (same `LEFT JOIN` parity as
 * {@link getChannelMessages}). Used by the gateway broadcast (story 003) so a live
 * `message.create` carries the just-linked attachment identically to history.
 */
export function getMessageWithAttachment(
  db: Db,
  id: number,
): MessageWithAttachment | undefined {
  const raw = db
    .prepare(
      `SELECT ${MESSAGE_JOIN_COLUMNS} FROM messages m LEFT JOIN attachments a ON a.id = m.attachment_id WHERE m.id = ?`,
    )
    .get(id) as MessageJoinRow | undefined;
  return raw === undefined ? undefined : splitMessageRow(raw);
}

/**
 * Updates a message's text content and stamps `edited_at = Date.now()`, returning
 * the persisted `MessageRow` (or `undefined` if the id no longer exists). Ownership
 * (`author_id === editor`) is the caller's responsibility — this accessor only writes.
 * The attachment is untouched: edits change text only (parity with {@link insertMessage}).
 */
export function updateMessageContent(
  db: Db,
  id: number,
  content: string,
): MessageRow | undefined {
  db.prepare("UPDATE messages SET content = ?, edited_at = ? WHERE id = ?").run(
    content,
    Date.now(),
    id,
  );
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as
    | MessageRow
    | undefined;
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
