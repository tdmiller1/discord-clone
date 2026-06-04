/**
 * Typed REST client for the story-003 auth-api contract.
 * Centralizes URL building, the Authorization: Bearer header, and contract-accurate
 * mapping of HTTP status + { error } bodies to a discriminated result type so screens
 * can surface specific messages. No runes here; bundler imports (no .js suffix).
 */
import type { SessionResponse } from "./types";

export type AuthErrorCode =
  | "invalid_token"
  | "username_taken"
  | "invalid_credentials"
  | "bad_request"
  | "rate_limited"
  | "unauthorized"
  | "network"
  | "unknown";

export type AuthResult =
  | { ok: true; data: SessionResponse }
  | { ok: false; error: AuthErrorCode; status?: number };

/** Maps an HTTP status + parsed body.error to an AuthErrorCode per the contract. */
function mapError(status: number, bodyError: unknown): AuthErrorCode {
  if (status === 429) return "rate_limited";
  if (status === 409) return "username_taken";
  if (status === 401) {
    return bodyError === "unauthorized" ? "unauthorized" : "invalid_credentials";
  }
  if (status === 400) {
    return bodyError === "invalid_token" ? "invalid_token" : "bad_request";
  }
  return "unknown";
}

/** POST helper: JSON body + optional Bearer token; defensive JSON parse; network → result. */
async function post(
  serverUrl: string,
  path: string,
  okStatus: number,
  body?: unknown,
  token?: string,
): Promise<AuthResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(new URL(path, serverUrl), {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "network" };
  }

  const parsed = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    session?: unknown;
    expiresAt?: unknown;
    user?: unknown;
  };

  if (res.status === okStatus) {
    return { ok: true, data: parsed as unknown as SessionResponse };
  }
  return { ok: false, error: mapError(res.status, parsed.error), status: res.status };
}

/** POST /api/register — no Bearer; success on 201. */
export function register(args: {
  serverUrl: string;
  token: string;
  username: string;
  password: string;
}): Promise<AuthResult> {
  const { serverUrl, token, username, password } = args;
  return post(serverUrl, "/api/register", 201, { token, username, password });
}

/** POST /api/login — no Bearer; success on 200. */
export function login(args: {
  serverUrl: string;
  username: string;
  password: string;
}): Promise<AuthResult> {
  const { serverUrl, username, password } = args;
  return post(serverUrl, "/api/login", 200, { username, password });
}

/** POST /api/logout (Bearer) — best-effort server-side revoke; never throws. */
export async function logout(serverUrl: string, token: string): Promise<void> {
  try {
    await fetch(new URL("/api/logout", serverUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort: the caller clears the keychain + store regardless
  }
}

/** POST /api/refresh (Bearer) — launch-time validator; rotates the token on success (200). */
export function validateSession(serverUrl: string, token: string): Promise<AuthResult> {
  return post(serverUrl, "/api/refresh", 200, undefined, token);
}
