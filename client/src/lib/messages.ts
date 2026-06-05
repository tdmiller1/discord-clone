/**
 * Typed REST client for the story-003 message-history endpoint
 * (GET /api/channels/:id/messages). Mirrors channels.ts: URL building, the
 * Authorization: Bearer header, defensive JSON parse, and contract-accurate
 * mapping of HTTP status to a discriminated result type. Returns messages
 * newest-first exactly as the server sends them; callers reverse for display.
 * No runes here; bundler imports (no .js suffix).
 */
import type { PublicMessage } from "./types";

export type MessagesErrorCode =
  | "channel_not_found"
  | "bad_request"
  | "unauthorized"
  | "network"
  | "unknown";

export type MessagesResult =
  | { ok: true; data: PublicMessage[] }
  | { ok: false; error: MessagesErrorCode; status?: number };

/** Maps an HTTP status to a MessagesErrorCode per the contract. */
function mapError(status: number): MessagesErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 404) return "channel_not_found";
  if (status === 400) return "bad_request";
  return "unknown";
}

/** GET /api/channels/:id/messages (Bearer) — recent history, newest-first; success on 200. */
export async function fetchMessages(args: {
  serverUrl: string;
  token: string;
  channelId: number;
  before?: number;
  limit?: number;
}): Promise<MessagesResult> {
  const { serverUrl, token, channelId, before, limit } = args;

  const url = new URL(`/api/channels/${channelId}/messages`, serverUrl);
  if (before !== undefined) url.searchParams.set("before", String(before));
  if (limit !== undefined) url.searchParams.set("limit", String(limit));

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, error: "network" };
  }

  const parsed = (await res.json().catch(() => [])) as PublicMessage[];

  if (res.status === 200) {
    return { ok: true, data: parsed };
  }
  return { ok: false, error: mapError(res.status), status: res.status };
}
