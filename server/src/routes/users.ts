import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { requireAuth } from "../auth.js";
import { deleteAttachment, getAttachmentById } from "../attachments.js";
import { parseImageUpload, persistImageAttachment } from "../uploads.js";
import { toPublicUser, type UserRow } from "../types.js";

interface UserRoutesOptions {
  config: Config;
}

const updateUsernameSchema = {
  body: {
    type: "object",
    required: ["username"],
    properties: {
      // Mirrors the register rule (SPEC.md §6): 1–64 chars; trimmed + emptiness
      // re-checked in the handler since a whitespace-only string passes minLength.
      username: { type: "string", minLength: 1, maxLength: 64 },
    },
    additionalProperties: false,
  },
} as const;

/**
 * User-profile REST endpoints (SPEC.md §6). `PATCH /api/users/me` lets the
 * signed-in user change their own username. Bearer-guarded via {@link requireAuth}
 * and rate-limited like the other auth endpoints. On success it broadcasts
 * `user.update` so every connected client refreshes its member list and message
 * author names live — the session/token is unaffected (username isn't part of it).
 */
const userRoutes: FastifyPluginAsync<UserRoutesOptions> = async (
  app: FastifyInstance,
  opts: UserRoutesOptions,
) => {
  const { config } = opts;
  const db = app.db;
  const rateLimitConfig = {
    rateLimit: { max: config.authRateMax, timeWindow: config.authRateWindowMs },
  };

  app.patch<{ Body: { username: string } }>(
    "/api/users/me",
    { schema: updateUsernameSchema, preHandler: requireAuth, config: rateLimitConfig },
    async (request, reply) => {
      const username = request.body.username.trim();
      if (username.length === 0) {
        return reply.code(400).send({ error: "username_invalid" });
      }

      const userId = request.user!.id;
      // Unchanged → succeed without a needless UNIQUE check or broadcast (also lets
      // the user re-save the same name harmlessly instead of hitting "taken").
      if (username === request.user!.username) {
        return reply.code(200).send({ user: request.user });
      }

      try {
        db.prepare("UPDATE users SET username = ? WHERE id = ?").run(username, userId);
      } catch (err) {
        // The `username` UNIQUE index rejects a collision — map it like register's 409.
        if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
          return reply.code(409).send({ error: "username_taken" });
        }
        throw err;
      }

      const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow;
      const user = toPublicUser(row);
      // Fan out to every authed socket (incl. this user's other tabs) so member
      // lists + already-rendered message authors update without a reconnect.
      request.server.broadcast({ op: "user.update", d: { user } });
      return reply.code(200).send({ user });
    },
  );

  // PATCH /api/users/me/avatar — set/replace the signed-in user's profile picture.
  // Accepts a single multipart image (byte-sniffed + `MAX_UPLOAD_MB`-capped via the
  // shared upload pipeline), stores it as an unlinked attachment, points the user
  // row at it, reclaims the previous avatar's row + file, and broadcasts
  // `user.update` so every client refreshes the picture live (like username change).
  app.patch(
    "/api/users/me/avatar",
    { preHandler: requireAuth, config: rateLimitConfig },
    async (request, reply) => {
      const upload = await parseImageUpload(request);
      if (!upload.ok) {
        return reply.code(upload.status).send({ error: upload.error });
      }

      const userId = request.user!.id;
      const prevAvatarId = request.user!.avatarId;

      const attachment = await persistImageAttachment(db, config, upload, userId);
      db.prepare("UPDATE users SET avatar_attachment_id = ? WHERE id = ?").run(
        attachment.id,
        userId,
      );

      // Reclaim the superseded avatar (best-effort): only when it's an unlinked
      // upload — never touch an attachment that's tied to a message. Failure to
      // remove the stale bytes must not fail the change, so swallow fs errors.
      if (prevAvatarId !== null) {
        const old = getAttachmentById(db, prevAvatarId);
        if (old !== undefined && old.message_id === null) {
          deleteAttachment(db, prevAvatarId);
          await fs.rm(join(config.dataDir, old.path), { force: true }).catch(() => {});
        }
      }

      const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow;
      const user = toPublicUser(row);
      request.server.broadcast({ op: "user.update", d: { user } });
      return reply.code(200).send({ user });
    },
  );
};

export default userRoutes;
