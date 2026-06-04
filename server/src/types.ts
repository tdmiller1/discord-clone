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

export interface ChannelRow {
  id: number;
  name: string;
  type: "text" | "voice";
  position: number;
  created_by: number | null;
  created_at: number;
}

export interface MessageRow {
  id: number;
  channel_id: number;
  author_id: number;
  content: string;
  attachment_id: number | null;
  created_at: number;
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

/** A channel as returned to clients (ready.channels, channel.create, REST). */
export interface PublicChannel {
  id: number;
  name: string;
  type: "text" | "voice";
  position: number;
  createdBy: number | null;
  createdAt: number;
}

export function toPublicChannel(row: ChannelRow): PublicChannel {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    position: row.position,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** A message as returned to clients (message.create, history fetch). */
export interface PublicMessage {
  id: number;
  channelId: number;
  authorId: number;
  content: string;
  attachmentId: number | null;
  createdAt: number;
}

export function toPublicMessage(row: MessageRow): PublicMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    authorId: row.author_id,
    content: row.content,
    attachmentId: row.attachment_id,
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
  channels: never[]; // empty placeholder; becomes PublicChannel[] in story 002
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
