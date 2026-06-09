import type { Db } from "./db.js";
import { generateToken, hashToken } from "./crypto.js";

/**
 * Invite-token helpers shared by the admin CLI ({@link ./cli.ts}) and the
 * first-run bootstrap in {@link ./index.ts}, so there is a single place that
 * mints single-use tokens (stored hashed at rest — SPEC.md §6).
 */

/** Mints a single-use invite token, persisting only its hash, and returns the raw token to show once. */
export function mintToken(db: Db): string {
  const raw = generateToken();
  db.prepare(
    "INSERT INTO invite_tokens (token_hash, created_by, created_at, revoked) VALUES (?, NULL, ?, 0)",
  ).run(hashToken(raw), Date.now());
  return raw;
}

/**
 * First-run convenience: when the deployment has no users yet, mint a single-use
 * invite token so the very first account can register without a separate
 * `server mint-token` invocation (SPEC.md §6). Returns the raw token to log, or
 * `null` once a user exists — at which point invite tokens are managed only via
 * the CLI and this never touches the table again.
 *
 * While still unbootstrapped it first clears any prior unused token so exactly
 * one usable token is outstanding; that keeps `tsx watch` reloads (and plain
 * restarts) from accumulating dead tokens while printing a fresh, valid one each
 * boot. Safe because with zero users there is no admin who could have minted a
 * token for someone else.
 */
export function ensureBootstrapToken(db: Db): string | null {
  const { n: userCount } = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (userCount > 0) return null;

  db.prepare("DELETE FROM invite_tokens WHERE used_by IS NULL AND revoked = 0").run();
  return mintToken(db);
}
