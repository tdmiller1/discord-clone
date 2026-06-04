/**
 * Shared row shapes for the M1 auth tables (SPEC.md §8) and the public response
 * shape returned to clients. better-sqlite3 `.get()` returns `unknown`, so these
 * types are the single place those rows are cast.
 *
 * DB columns are snake_case; the public API shape is camelCase.
 */

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string | null;
  created_at: number;
  disabled: number; // 0 | 1
}

export interface SessionRow {
  id: number;
  user_id: number;
  token_hash: string;
  created_at: number;
  expires_at: number;
  revoked: number; // 0 | 1
}

export interface InviteTokenRow {
  id: number;
  token_hash: string;
  created_by: number | null;
  created_at: number;
  used_by: number | null;
  used_at: number | null;
  revoked: number; // 0 | 1
}

/** The user shape returned to clients — never includes `password_hash`. */
export interface PublicUser {
  id: number;
  username: string;
  displayName: string | null;
  createdAt: number;
}

/** Maps a `users` row (snake_case, with the hash) to the public API shape. */
export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

/** Live presence state of a user (SPEC.md §7). */
export type PresenceStatus = "online" | "offline";

/** A user as it appears in `ready.members`: PublicUser + live presence. */
export interface Member extends PublicUser {
  status: PresenceStatus;
  voiceChannelId: number | null; // always null in M1 (voice arrives M4)
}

/** Generic realtime WS envelope (SPEC.md §7). */
export interface Envelope<Op extends string = string, D = unknown> {
  op: Op;
  d: D;
}

/** server→client: op `ready` (sent once after a successful `identify`). */
export interface ReadyPayload {
  user: PublicUser;
  channels: never[]; // empty placeholder until M2
  members: Member[];
}

/** server→client: op `presence.update`. */
export interface PresenceUpdatePayload {
  userId: number;
  status: PresenceStatus;
  voiceChannelId: number | null;
}

/** client→server: op `identify` (the only inbound op in M1). */
export interface IdentifyPayload {
  token: string;
}

/** Discriminated union of every server→client event the gateway emits in M1. */
export type ServerEvent =
  | Envelope<"ready", ReadyPayload>
  | Envelope<"presence.update", PresenceUpdatePayload>;

/** Discriminated union of every client→server command the gateway accepts in M1. */
export type ClientCommand = Envelope<"identify", IdentifyPayload>;
