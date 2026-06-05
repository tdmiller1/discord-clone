import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { createReadStream, promises as fs } from "node:fs";
import { join } from "node:path";
import { type Config, imagesDir } from "../config.js";
import { requireAuth } from "../auth.js";
import { createAttachment, getAttachmentById } from "../attachments.js";
import { toPublicAttachment } from "../types.js";
import { sniffImage } from "../images.js";

interface AttachmentRoutesOptions {
  config: Config;
}

const downloadParamsSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  },
} as const;

/**
 * Attachment REST endpoints (SPEC.md §10). `POST /api/attachments` accepts a
 * single multipart image field, byte-sniffs the MIME (never trusting the client
 * Content-Type/filename), enforces the `MAX_UPLOAD_MB` cap, probes width/height,
 * writes the bytes to `DATA_DIR/images/<id>` and records the unlinked row.
 * `GET /api/attachments/:id` streams the stored bytes with the stored
 * `Content-Type`/`Content-Length`. Both are Bearer-guarded via {@link requireAuth}
 * and read the shared `app.db`.
 */
const attachmentRoutes: FastifyPluginAsync<AttachmentRoutesOptions> = async (
  app: FastifyInstance,
  opts: AttachmentRoutesOptions,
) => {
  const { config } = opts;
  const db = app.db;

  app.post(
    "/api/attachments",
    { preHandler: requireAuth },
    async (request, reply) => {
      let part;
      try {
        part = await request.file();
      } catch (err) {
        if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.code(413).send({ error: "file_too_large" });
        }
        return reply.code(400).send({ error: "not_multipart" });
      }

      if (part === undefined) {
        return reply.code(400).send({ error: "no_file" });
      }

      let buffer: Buffer;
      try {
        buffer = await part.toBuffer();
      } catch (err) {
        if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.code(413).send({ error: "file_too_large" });
        }
        throw err;
      }

      if (part.file.truncated) {
        return reply.code(413).send({ error: "file_too_large" });
      }
      if (buffer.length === 0) {
        return reply.code(400).send({ error: "no_file" });
      }

      const probe = sniffImage(buffer);
      if (probe === null) {
        return reply.code(400).send({ error: "invalid_image" });
      }

      const filename = part.filename ?? "upload";
      const row = createAttachment(db, {
        uploaderId: request.user!.id,
        filename,
        contentType: probe.contentType,
        size: buffer.length,
        width: probe.width,
        height: probe.height,
        path: "",
      });

      const relPath = join("images", String(row.id));
      const absPath = join(imagesDir(config), String(row.id));
      try {
        await fs.writeFile(absPath, buffer);
        db.prepare("UPDATE attachments SET path = ? WHERE id = ?").run(
          relPath,
          row.id,
        );
      } catch (err) {
        db.prepare("DELETE FROM attachments WHERE id = ?").run(row.id);
        await fs.rm(absPath, { force: true });
        throw err;
      }

      return reply.code(201).send(toPublicAttachment({ ...row, path: relPath }));
    },
  );

  app.get<{ Params: { id: number } }>(
    "/api/attachments/:id",
    { schema: downloadParamsSchema, preHandler: requireAuth },
    async (request, reply) => {
      const row = getAttachmentById(db, request.params.id);
      if (row === undefined) {
        return reply.code(404).send({ error: "attachment_not_found" });
      }

      const absPath = join(config.dataDir, row.path);
      try {
        await fs.stat(absPath);
      } catch {
        return reply.code(404).send({ error: "attachment_not_found" });
      }

      reply.header("Content-Type", row.content_type);
      reply.header("Content-Length", row.size);
      return reply.send(createReadStream(absPath));
    },
  );
};

export default attachmentRoutes;
