/**
 * Typed REST client for the story-003 channels-rest-api contract.
 * Centralizes URL building, the Authorization: Bearer header, and contract-accurate
 * mapping of HTTP status + { error } bodies to a discriminated result type so screens
 * can surface specific messages. No runes here; bundler imports (no .js suffix).
 */
import type { PublicChannel } from "./types";

export type ChannelErrorCode =
  | "channel_name_invalid"
  | "bad_request"
  | "unauthorized"
  | "network"
  | "unknown";

export type ChannelResult =
  | { ok: true; data: PublicChannel }
  | { ok: false; error: ChannelErrorCode; status?: number };

/** Maps an HTTP status + parsed body.error to a ChannelErrorCode per the contract. */
function mapError(status: number, bodyError: unknown): ChannelErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 400) {
    // `channel_name_invalid` (whitespace-only name) vs `"Bad Request"` (schema validation).
    return bodyError === "channel_name_invalid" ? "channel_name_invalid" : "bad_request";
  }
  return "unknown";
}

/** POST /api/channels (Bearer) — create a text channel; success on 201. */
export async function createChannel(args: {
  serverUrl: string;
  token: string;
  name: string;
}): Promise<ChannelResult> {
  const { serverUrl, token, name } = args;

  let res: Response;
  try {
    res = await fetch(new URL("/api/channels", serverUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name, type: "text" }),
    });
  } catch {
    return { ok: false, error: "network" };
  }

  const parsed = (await res.json().catch(() => ({}))) as { error?: unknown };

  if (res.status === 201) {
    return { ok: true, data: parsed as unknown as PublicChannel };
  }
  return { ok: false, error: mapError(res.status, parsed.error), status: res.status };
}
