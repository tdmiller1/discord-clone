/**
 * Typed REST client for the story-003 auth-api contract.
 * Centralizes URL building, the Authorization: Bearer header, and contract-accurate
 * mapping of HTTP status + { error } bodies to a discriminated result type so screens
 * can surface specific messages. No runes here; bundler imports (no .js suffix).
 */
import type { PublicUser, SessionResponse } from "./types";

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

export type InviteResult =
  | { ok: true; token: string }
  | { ok: false; error: AuthErrorCode };

/** POST /api/invites (Bearer) — mint a single-use invite token; success on 201. Returns the
 * raw token (not a SessionResponse), so it doesn't go through `post`. */
export async function createInvite(serverUrl: string, token: string): Promise<InviteResult> {
  let res: Response;
  try {
    res = await fetch(new URL("/api/invites", serverUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, error: "network" };
  }
  const parsed = (await res.json().catch(() => ({}))) as { token?: unknown; error?: unknown };
  if (res.status === 201 && typeof parsed.token === "string") {
    return { ok: true, token: parsed.token };
  }
  return { ok: false, error: mapError(res.status, parsed.error) };
}

export type UpdateUsernameResult =
  | { ok: true; user: PublicUser }
  | { ok: false; error: AuthErrorCode };

/**
 * PATCH /api/users/me (Bearer) — change the signed-in user's username. Returns the
 * updated PublicUser on 200; maps 409→username_taken, 400→bad_request,
 * 429→rate_limited, 401→unauthorized, network failure→network (reuses {@link mapError}).
 * The session/token is unchanged, so callers keep using the same token afterward.
 */
export async function updateUsername(args: {
  serverUrl: string;
  token: string;
  username: string;
}): Promise<UpdateUsernameResult> {
  const { serverUrl, token, username } = args;
  let res: Response;
  try {
    res = await fetch(new URL("/api/users/me", serverUrl), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ username }),
    });
  } catch {
    return { ok: false, error: "network" };
  }
  const parsed = (await res.json().catch(() => ({}))) as { user?: unknown; error?: unknown };
  if (res.status === 200 && parsed.user !== undefined) {
    return { ok: true, user: parsed.user as PublicUser };
  }
  return { ok: false, error: mapError(res.status, parsed.error) };
}

/** Avatar-specific error codes (a superset-ish of the image-upload contract): the
 * upload can be rejected for size/format reasons the username PATCH never sees. */
export type AvatarErrorCode =
  | "file_too_large"
  | "invalid_image"
  | "no_file"
  | "rate_limited"
  | "unauthorized"
  | "network"
  | "unknown";

export type UpdateAvatarResult =
  | { ok: true; user: PublicUser }
  | { ok: false; error: AvatarErrorCode };

/** Maps an HTTP status + body.error from the avatar endpoint to an AvatarErrorCode. */
function mapAvatarError(status: number, bodyError: unknown): AvatarErrorCode {
  if (status === 429) return "rate_limited";
  if (status === 401) return "unauthorized";
  if (status === 413) return "file_too_large";
  if (status === 400) {
    if (bodyError === "invalid_image") return "invalid_image";
    if (bodyError === "no_file") return "no_file";
    return "invalid_image"; // not_multipart / bad_request — surface as a format problem
  }
  return "unknown";
}

/**
 * PATCH /api/users/me/avatar (Bearer) — set/replace the signed-in user's profile
 * picture. multipart/form-data with a single `file` part; NO Content-Type header so
 * the browser supplies the boundary (mirrors attachments.ts). Returns the updated
 * PublicUser (with the new `avatarId`) on 200; every other client refreshes via the
 * server's `user.update` broadcast. The session/token is unaffected.
 */
export async function updateAvatar(args: {
  serverUrl: string;
  token: string;
  file: File;
}): Promise<UpdateAvatarResult> {
  const { serverUrl, token, file } = args;

  const form = new FormData();
  form.append("file", file);

  let res: Response;
  try {
    res = await fetch(new URL("/api/users/me/avatar", serverUrl), {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch {
    return { ok: false, error: "network" };
  }

  const parsed = (await res.json().catch(() => ({}))) as { user?: unknown; error?: unknown };
  if (res.status === 200 && parsed.user !== undefined) {
    return { ok: true, user: parsed.user as PublicUser };
  }
  return { ok: false, error: mapAvatarError(res.status, parsed.error) };
}
