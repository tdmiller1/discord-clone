import type { FastifyRequest } from "fastify";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { type AllowedImageType, type Config, imagesDir } from "./config.js";
import type { Db } from "./db.js";
import { createAttachment } from "./attachments.js";
import type { AttachmentRow } from "./types.js";
import { sniffImage } from "./images.js";

/**
 * Shared multipart image-upload pipeline (SPEC.md §10), used by both the
 * attachments route and the avatar route so the validation + on-disk write stay
 * identical (byte-sniffed MIME, `MAX_UPLOAD_MB` cap, truncation/empty checks).
 *
 * `parseImageUpload` returns a discriminated result instead of writing the HTTP
 * reply, so each route maps the `{ status, error }` to its own `reply.code().send()`
 * (the error codes match the existing attachments contract verbatim).
 */
export type ImageUpload =
  | {
      ok: true;
      buffer: Buffer;
      filename: string;
      contentType: AllowedImageType;
      width: number;
      height: number;
    }
  | { ok: false; status: number; error: string };

/** Parses + validates the single multipart image part on `request`. Never throws
 * for client errors (too-large/empty/not-an-image); only re-throws unexpected ones. */
export async function parseImageUpload(request: FastifyRequest): Promise<ImageUpload> {
  let part;
  try {
    part = await request.file();
  } catch (err) {
    if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      return { ok: false, status: 413, error: "file_too_large" };
    }
    return { ok: false, status: 400, error: "not_multipart" };
  }

  if (part === undefined) {
    return { ok: false, status: 400, error: "no_file" };
  }

  let buffer: Buffer;
  try {
    buffer = await part.toBuffer();
  } catch (err) {
    if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      return { ok: false, status: 413, error: "file_too_large" };
    }
    throw err;
  }

  if (part.file.truncated) {
    return { ok: false, status: 413, error: "file_too_large" };
  }
  if (buffer.length === 0) {
    return { ok: false, status: 400, error: "no_file" };
  }

  const probe = sniffImage(buffer);
  if (probe === null) {
    return { ok: false, status: 400, error: "invalid_image" };
  }

  return {
    ok: true,
    buffer,
    filename: part.filename ?? "upload",
    contentType: probe.contentType,
    width: probe.width,
    height: probe.height,
  };
}

/**
 * Records an attachment row and writes its bytes to `DATA_DIR/images/<id>`,
 * returning the row with its relative `path` set. On a write failure it rolls back
 * the row + any partial file so a failed upload never leaves a dangling record.
 */
export async function persistImageAttachment(
  db: Db,
  config: Config,
  upload: Extract<ImageUpload, { ok: true }>,
  uploaderId: number,
): Promise<AttachmentRow> {
  const row = createAttachment(db, {
    uploaderId,
    filename: upload.filename,
    contentType: upload.contentType,
    size: upload.buffer.length,
    width: upload.width,
    height: upload.height,
    path: "",
  });

  const relPath = join("images", String(row.id));
  const absPath = join(imagesDir(config), String(row.id));
  try {
    await fs.writeFile(absPath, upload.buffer);
    db.prepare("UPDATE attachments SET path = ? WHERE id = ?").run(relPath, row.id);
  } catch (err) {
    db.prepare("DELETE FROM attachments WHERE id = ?").run(row.id);
    await fs.rm(absPath, { force: true });
    throw err;
  }

  return { ...row, path: relPath };
}
