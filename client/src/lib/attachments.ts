/**
 * Typed REST client for the story-002 attachments-rest-api contract
 * (POST /api/attachments). Mirrors channels.ts/messages.ts/auth.ts: URL building,
 * the Authorization: Bearer header, defensive JSON parse, and contract-accurate
 * mapping of HTTP status + { error } bodies to a discriminated result type.
 * The body is multipart/form-data with a single `file` part; NO Content-Type header
 * is set so the browser supplies the multipart boundary.
 * No runes here; bundler imports (no .js suffix).
 */
import type { PublicAttachment } from "./types";

export type AttachmentErrorCode =
  | "unauthorized"
  | "file_too_large"
  | "invalid_image"
  | "no_file"
  | "not_multipart"
  | "bad_request"
  | "network"
  | "unknown";

export type AttachmentResult =
  | { ok: true; data: PublicAttachment }
  | { ok: false; error: AttachmentErrorCode; status?: number };

/** Maps an HTTP status + parsed body.error to an AttachmentErrorCode per the contract. */
function mapError(status: number, bodyError: unknown): AttachmentErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 413) return "file_too_large";
  if (status === 400) {
    if (bodyError === "invalid_image") return "invalid_image";
    if (bodyError === "no_file") return "no_file";
    if (bodyError === "not_multipart") return "not_multipart";
    return "bad_request";
  }
  return "unknown";
}

/** POST /api/attachments (Bearer) — multipart upload of a single image; success on 201. */
export async function uploadAttachment(args: {
  serverUrl: string;
  token: string;
  file: File;
}): Promise<AttachmentResult> {
  const { serverUrl, token, file } = args;

  const form = new FormData();
  form.append("file", file);

  let res: Response;
  try {
    res = await fetch(new URL("/api/attachments", serverUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch {
    return { ok: false, error: "network" };
  }

  const parsed = (await res.json().catch(() => ({}))) as { error?: unknown };

  if (res.status === 201) {
    return { ok: true, data: parsed as unknown as PublicAttachment };
  }
  return { ok: false, error: mapError(res.status, parsed.error), status: res.status };
}
