import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { createReadStream, promises as fs } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { requireAuth } from "../auth.js";
import { getAttachmentById } from "../attachments.js";
import { toPublicAttachment } from "../types.js";
import { parseImageUpload, persistImageAttachment } from "../uploads.js";

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
      const upload = await parseImageUpload(request);
      if (!upload.ok) {
        return reply.code(upload.status).send({ error: upload.error });
      }

      const row = await persistImageAttachment(db, config, upload, request.user!.id);
      return reply.code(201).send(toPublicAttachment(row));
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
