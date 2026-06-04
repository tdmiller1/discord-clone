import type { FastifyReply, FastifyRequest } from "fastify";
import { hashToken } from "./crypto.js";
import type { Db } from "./db.js";
import { toPublicUser, type PublicUser, type SessionRow, type UserRow } from "./types.js";

/** Uniform unauthorized body — reused for every auth failure so nothing is leaked. */
const UNAUTHORIZED = { error: "unauthorized" } as const;

/**
 * Validates an opaque session token against the store, framework-agnostically so
 * the WebSocket gateway (story 004) can reuse it with the token from the connect
 * frame — no Fastify request involved.
 *
 * Hashes the raw token, looks it up by `idx_sessions_token_hash`, rejects
 * missing/revoked/expired sessions, then loads the owning user and rejects a
 * missing or disabled account. Returns `{ user, session }` on success or `null`
 * on any failure (never throws), letting REST return a uniform 401 and WS close
 * with an auth-failure code.
 */
export function authenticateSession(
  db: Db,
  rawToken: string,
): { user: PublicUser; session: SessionRow } | null {
  if (!rawToken) return null;

  const session = db
    .prepare("SELECT * FROM sessions WHERE token_hash = ?")
    .get(hashToken(rawToken)) as SessionRow | undefined;
  if (!session || session.revoked === 1 || session.expires_at <= Date.now()) {
    return null;
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) as
    | UserRow
    | undefined;
  if (!user || user.disabled === 1) {
    return null;
  }

  return { user: toPublicUser(user), session };
}

/** Extracts the raw token from an `Authorization: Bearer <token>` header, or `null`. */
export function parseBearer(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

/**
 * Fastify `preHandler` guarding authenticated routes. Parses the Bearer header,
 * validates the session via {@link authenticateSession}, and on success attaches
 * `request.user` (PublicUser) and `request.session` (SessionRow). On any failure
 * it replies with a uniform 401 and short-circuits the request.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const raw = parseBearer(request.headers.authorization);
  if (!raw) {
    await reply.code(401).send(UNAUTHORIZED);
    return;
  }
  const result = authenticateSession(request.server.db, raw);
  if (!result) {
    await reply.code(401).send(UNAUTHORIZED);
    return;
  }
  request.user = result.user;
  request.session = result.session;
}
