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

export interface AttachmentRow {
  id: number;
  message_id: number | null;
  uploader_id: number;
  filename: string;
  content_type: string;
  size: number;
  width: number | null;
  height: number | null;
  path: string;
  created_at: number; // epoch ms
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

/**
 * An attachment as returned to clients (embedded in `PublicMessage`). Exposes
 * `id`, not a baked URL: the download is auth-checked, so the client resolves the
 * bytes itself via `GET /api/attachments/:id` (SPEC.md §10).
 */
export interface PublicAttachment {
  id: number;
  messageId: number | null;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  createdAt: number;
}

export function toPublicAttachment(row: AttachmentRow): PublicAttachment {
  return {
    id: row.id,
    messageId: row.message_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  };
}

/** A message as returned to clients (message.create, history fetch). */
export interface PublicMessage {
  id: number;
  channelId: number;
  authorId: number;
  content: string;
  attachment: PublicAttachment | null;
  createdAt: number;
}

export function toPublicMessage(
  row: MessageRow,
  attachment: AttachmentRow | null,
): PublicMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    authorId: row.author_id,
    content: row.content,
    attachment: attachment ? toPublicAttachment(attachment) : null,
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
  channels: PublicChannel[];
  members: Member[];
}

/** server→client: op `presence.update`. */
export interface PresenceUpdatePayload {
  userId: number;
  status: PresenceStatus;
  voiceChannelId: number | null;
}

/** client→server: op `identify` (the M1 auth handshake). */
export interface IdentifyPayload {
  token: string;
}

/** client→server: op `message.send` (`attachmentId` linking is honored by M3 story 003). */
export interface MessageSendPayload {
  channelId: number;
  content: string;
  attachmentId?: number | null;
}

/** server→client: op `message.create` (broadcast to all sockets, incl. the sender). */
export interface MessageCreatePayload {
  message: PublicMessage;
}

/** server→client: op `channel.create` (emitted by the REST layer via `app.broadcast`). */
export interface ChannelCreatePayload {
  channel: PublicChannel;
}

/** Discriminated union of every server→client event the gateway emits. */
export type ServerEvent =
  | Envelope<"ready", ReadyPayload>
  | Envelope<"presence.update", PresenceUpdatePayload>
  | Envelope<"message.create", MessageCreatePayload>
  | Envelope<"channel.create", ChannelCreatePayload>;

/** Discriminated union of every client→server command the gateway accepts. */
export type ClientCommand =
  | Envelope<"identify", IdentifyPayload>
  | Envelope<"message.send", MessageSendPayload>;
