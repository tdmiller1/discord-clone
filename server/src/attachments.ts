import type { Db } from "./db.js";
import type { AttachmentRow } from "./types.js";

/**
 * Single source of truth for attachment persistence (SPEC.md §8/§10).
 * Framework-agnostic accessors built on the `Db` handle — every function takes
 * `db` as its first argument (mirroring {@link ./channels.ts createChannel}), so
 * the upload REST route (story 002) and the WS gateway link flow (story 003) call
 * them with the shared `app.db`/gateway handle and no second connection is opened.
 *
 * Write accessors re-`SELECT` the inserted row by `lastInsertRowid` and return the
 * full `AttachmentRow`, so callers can map to the public shape without a second
 * round-trip.
 */

/**
 * Inserts an unlinked attachment (`message_id` NULL) and returns the persisted
 * row. The file is written to disk by the caller (story 002); this only records
 * the row. `created_at` is `Date.now()`.
 */
export function createAttachment(
  db: Db,
  input: {
    uploaderId: number;
    filename: string;
    contentType: string;
    size: number;
    width: number | null;
    height: number | null;
    path: string;
  },
): AttachmentRow {
  const insert = db
    .prepare(
      "INSERT INTO attachments (message_id, uploader_id, filename, content_type, size, width, height, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      null,
      input.uploaderId,
      input.filename,
      input.contentType,
      input.size,
      input.width,
      input.height,
      input.path,
      Date.now(),
    );
  return db
    .prepare("SELECT * FROM attachments WHERE id = ?")
    .get(Number(insert.lastInsertRowid)) as AttachmentRow;
}

/** Looks up a single attachment by id, or `undefined` if it does not exist. */
export function getAttachmentById(
  db: Db,
  id: number,
): AttachmentRow | undefined {
  return db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as
    | AttachmentRow
    | undefined;
}

/**
 * Links an attachment to a message exactly once: sets `attachments.message_id`
 * only while it is still NULL. Returns `true` when the link was applied, `false`
 * when the attachment is already linked (or does not exist). The caller validates
 * uploader ownership (story 003) before calling.
 */
export function linkAttachmentToMessage(
  db: Db,
  attachmentId: number,
  messageId: number,
): boolean {
  const info = db
    .prepare(
      "UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL",
    )
    .run(messageId, attachmentId);
  return info.changes === 1;
}

/** Deletes an attachment row by id (no-op if absent). The caller removes the
 * on-disk file separately — used to reclaim a superseded avatar (SPEC.md §6). */
export function deleteAttachment(db: Db, id: number): void {
  db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
}
