import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Config } from "../config.js";
import {
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from "../crypto.js";
import type { Db } from "../db.js";
import { requireAuth } from "../auth.js";
import {
  toPublicUser,
  type InviteTokenRow,
  type PublicUser,
  type UserRow,
} from "../types.js";

interface AuthRoutesOptions {
  config: Config;
}

/** Tagged error so the register handler can map invite-token problems to a 400. */
class InviteTokenError extends Error {}

/**
 * Issues a session for `userId`: generates a raw token, stores only its hash with
 * `created_at`/`expires_at` (from the configured TTL) and `revoked = 0`, and
 * returns the raw token (the only place it is ever exposed) plus its expiry.
 */
function issueSession(
  db: Db,
  userId: number,
  ttlSeconds: number,
): { session: string; expiresAt: number } {
  const raw = generateToken();
  const createdAt = Date.now();
  const expiresAt = createdAt + ttlSeconds * 1000;
  db.prepare(
    "INSERT INTO sessions (user_id, token_hash, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)",
  ).run(userId, hashToken(raw), createdAt, expiresAt);
  return { session: raw, expiresAt };
}

const registerSchema = {
  body: {
    type: "object",
    required: ["token", "username", "password"],
    properties: {
      token: { type: "string", minLength: 1 },
      username: { type: "string", minLength: 1, maxLength: 64 },
      password: { type: "string", minLength: 8, maxLength: 256 },
    },
    additionalProperties: false,
  },
} as const;

const loginSchema = {
  body: {
    type: "object",
    required: ["username", "password"],
    properties: {
      username: { type: "string", minLength: 1 },
      password: { type: "string", minLength: 1 },
    },
    additionalProperties: false,
  },
} as const;

/**
 * REST auth endpoints (SPEC.md §6). Register/login are unauthenticated and
 * rate-limited; logout/refresh are guarded by {@link requireAuth}. The session
 * validator itself lives in `../auth.ts` so the WS gateway (story 004) can reuse
 * it without a Fastify request.
 */
const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  app: FastifyInstance,
  opts: AuthRoutesOptions,
) => {
  const { config } = opts;
  const db = app.db;
  const rateLimitConfig = {
    rateLimit: { max: config.authRateMax, timeWindow: config.authRateWindowMs },
  };

  app.post<{ Body: { token: string; username: string; password: string } }>(
    "/api/register",
    { schema: registerSchema, config: rateLimitConfig },
    async (request, reply) => {
      const { token, username, password } = request.body;

      // Hash the password before opening the (synchronous) transaction; the
      // token must not be consumed if the username collides, so token-check,
      // user-insert and token-mark all happen atomically.
      const passwordHash = await hashPassword(password);

      try {
        const userId = db.transaction((): number => {
          const invite = db
            .prepare("SELECT * FROM invite_tokens WHERE token_hash = ?")
            .get(hashToken(token)) as InviteTokenRow | undefined;
          if (!invite || invite.revoked === 1 || invite.used_by !== null) {
            throw new InviteTokenError();
          }

          const now = Date.now();
          const insert = db
            .prepare(
              "INSERT INTO users (username, password_hash, display_name, created_at, disabled) VALUES (?, ?, NULL, ?, 0)",
            )
            .run(username, passwordHash, now);
          const newUserId = Number(insert.lastInsertRowid);

          db.prepare(
            "UPDATE invite_tokens SET used_by = ?, used_at = ? WHERE id = ?",
          ).run(newUserId, now, invite.id);

          return newUserId;
        })();

        const userRow = db
          .prepare("SELECT * FROM users WHERE id = ?")
          .get(userId) as UserRow;
        const user: PublicUser = toPublicUser(userRow);
        const { session, expiresAt } = issueSession(
          db,
          userId,
          config.sessionTtlSeconds,
        );
        return reply.code(201).send({ session, expiresAt, user });
      } catch (err) {
        if (err instanceof InviteTokenError) {
          return reply.code(400).send({ error: "invalid_token" });
        }
        if (
          err instanceof Error &&
          err.message.includes("UNIQUE constraint failed")
        ) {
          return reply.code(409).send({ error: "username_taken" });
        }
        throw err;
      }
    },
  );

  app.post<{ Body: { username: string; password: string } }>(
    "/api/login",
    { schema: loginSchema, config: rateLimitConfig },
    async (request, reply) => {
      const { username, password } = request.body;
      const user = db
        .prepare("SELECT * FROM users WHERE username = ?")
        .get(username) as UserRow | undefined;

      // Uniform 401 for no-user / bad-password / disabled (no enumeration).
      const ok =
        user !== undefined &&
        user.disabled === 0 &&
        (await verifyPassword(user.password_hash, password));
      if (!user || !ok) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      const { session, expiresAt } = issueSession(
        db,
        user.id,
        config.sessionTtlSeconds,
      );
      return reply.code(200).send({ session, expiresAt, user: toPublicUser(user) });
    },
  );

  app.post(
    "/api/logout",
    { preHandler: requireAuth },
    async (request, reply) => {
      db.prepare("UPDATE sessions SET revoked = 1 WHERE id = ?").run(
        request.session!.id,
      );
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/refresh",
    { preHandler: requireAuth },
    async (request, reply) => {
      const current = request.session!;
      const rotated = db.transaction((): { session: string; expiresAt: number } => {
        db.prepare("UPDATE sessions SET revoked = 1 WHERE id = ?").run(current.id);
        return issueSession(db, current.user_id, config.sessionTtlSeconds);
      })();
      return reply
        .code(200)
        .send({ session: rotated.session, expiresAt: rotated.expiresAt, user: request.user });
    },
  );
};

export default authRoutes;
