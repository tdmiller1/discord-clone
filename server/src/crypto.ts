import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { randomBytes, createHash } from "node:crypto";

/**
 * Shared hashing and token helpers used by the REST API, the admin CLI and the
 * WebSocket gateway, so there is one implementation of the auth crypto.
 *
 * Passwords use Argon2id; opaque tokens (invite + session) are generated as
 * high-entropy random values and only ever stored as a SHA-256 hash
 * (see SPEC.md §6 auth flows and §12 security requirements).
 */

/** Hashes a password with Argon2id. Returns the encoded `$argon2id$...` string (embeds salt + params). */
export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password);
}

/**
 * Verifies a password against an Argon2id encoded hash. Returns `false` on a
 * mismatch or a malformed/non-Argon2 hash (never throws), so callers can return
 * a single uniform failure for both "no such user" and "wrong password".
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, password);
  } catch {
    return false;
  }
}

/** Generates a URL-safe opaque token (32 random bytes, base64url). Shown to the user once; never stored raw. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Hashes a raw token (invite or session) for at-rest storage in a `token_hash` column. SHA-256 hex. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
