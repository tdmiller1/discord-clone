/**
 * Auth-fetch → object-URL helper for inline image rendering (story 005). The
 * download endpoint GET /api/attachments/:id is Bearer-auth-checked, so a bare
 * <img src> would 401; instead we fetch the bytes with the session token and
 * wrap the blob in an object URL. Mirrors messages.ts/channels.ts: new URL(path,
 * serverUrl), the Authorization: Bearer header, try/catch → network, status →
 * typed error, and a discriminated result. No runes; bundler imports (no .js).
 *
 * A module-scope id cache keeps object URLs for the session (attachment bytes
 * are immutable — link-once, never edited per M3 non-goals) so scrollback /
 * re-render / channel-switch-back never re-fetch, and an in-flight map dedupes
 * concurrent first-mounts of the same id. The cache is revoked + cleared only by
 * clearCache() (logout/session-invalid) — never per-unmount, since revoking an
 * in-use URL would break other rows showing the same attachment.
 */

export type AttachmentImageError = "unauthorized" | "not_found" | "network" | "unknown";

export type AttachmentImageResult =
  | { ok: true; objectUrl: string }
  | { ok: false; error: AttachmentImageError; status?: number };

const cache = new Map<number, string>();
const inflight = new Map<number, Promise<AttachmentImageResult>>();

/** Maps an HTTP status to an AttachmentImageError per the story-002 contract. */
function mapError(status: number): AttachmentImageError {
  if (status === 401) return "unauthorized";
  if (status === 404) return "not_found";
  return "unknown";
}

async function fetchImage(args: {
  serverUrl: string;
  token: string;
  attachmentId: number;
}): Promise<AttachmentImageResult> {
  const { serverUrl, token, attachmentId } = args;
  const url = new URL(`/api/attachments/${attachmentId}`, serverUrl);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, error: "network" };
  }

  if (!res.ok) {
    return { ok: false, error: mapError(res.status), status: res.status };
  }

  let objectUrl: string;
  try {
    objectUrl = URL.createObjectURL(await res.blob());
  } catch {
    return { ok: false, error: "network" };
  }

  cache.set(attachmentId, objectUrl);
  return { ok: true, objectUrl };
}

/**
 * GET /api/attachments/:id (Bearer) → blob → object URL. Cache hit returns the
 * existing URL; a concurrent miss awaits the shared in-flight promise. Errors are
 * not cached so a later retry can still succeed. Never throws.
 */
export async function loadAttachmentImage(args: {
  serverUrl: string;
  token: string;
  attachmentId: number;
}): Promise<AttachmentImageResult> {
  const { attachmentId } = args;

  const cached = cache.get(attachmentId);
  if (cached !== undefined) return { ok: true, objectUrl: cached };

  const pending = inflight.get(attachmentId);
  if (pending !== undefined) return pending;

  const promise = fetchImage(args).finally(() => {
    inflight.delete(attachmentId);
  });
  inflight.set(attachmentId, promise);
  return promise;
}

/** Returns the cached object URL for an id, or undefined — used by InlineImage's
 * cleanup to avoid revoking a still-cached (shared) URL. */
export function cachedObjectUrl(attachmentId: number): string | undefined {
  return cache.get(attachmentId);
}

/** Revokes every cached object URL and empties both maps. Called on logout /
 * session-invalid so blobs don't leak and a re-login can't show a prior
 * session's images. */
export function clearCache(): void {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
  inflight.clear();
}
