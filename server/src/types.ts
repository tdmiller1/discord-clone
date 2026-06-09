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
  voiceChannelId: number | null; // live voice channel from VoiceRegistry (M4)
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

/**
 * server→client: op `user.update` — a user changed their profile (currently just
 * username). Carries the full PublicUser so clients can refresh the member list and
 * historical message author names without a reconnect (presence is unaffected).
 */
export interface UserUpdatePayload {
  user: PublicUser;
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

// ---------- voice: client → server (SPEC.md §7/§11; M4 story 003) ----------
//
// mediasoup param objects (`dtlsParameters`, `rtpParameters`, `rtpCapabilities`)
// are passed through verbatim to the SFU, which owns their concrete types. They
// are typed `unknown` at this boundary so the shared `types.ts` does not import
// `mediasoup`; the gateway validates only that they are non-null objects.

/** client→server: op `voice.join` — request to join the seeded voice channel. */
export interface VoiceJoinPayload {
  channelId: number;
}

/** client→server: op `voice.transport` — request a send|recv WebRtcTransport. */
export interface VoiceTransportRequestPayload {
  direction: "send" | "recv";
}

/** client→server: op `voice.connect` — complete DTLS for a transport. */
export interface VoiceConnectPayload {
  direction: "send" | "recv";
  dtlsParameters: unknown;
}

/** client→server: op `voice.produce` — publish the mic track. */
export interface VoiceProducePayload {
  rtpParameters: unknown;
}

/** client→server: op `voice.consume` — consume a remote producer (server replies paused). */
export interface VoiceConsumePayload {
  producerId: string;
  rtpCapabilities: unknown;
}

/** client→server: op `voice.resume` — resume a previously-consumed producer post-handshake. */
export interface VoiceResumePayload {
  producerId: string;
}

/** client→server: op `voice.state` — mute/deafen toggle. `deafened` is local playback only. */
export interface VoiceStatePayload {
  muted: boolean;
  deafened?: boolean;
}

/** client→server: op `voice.leave` — leave the voice channel (no fields). */
export type VoiceLeavePayload = Record<string, never>;

// ---------- voice: server → client ----------

/** server→client: op `voice.joined` — ack of `voice.join`: router caps + existing producers. */
export interface VoiceJoinedPayload {
  channelId: number;
  participantId: string;
  rtpCapabilities: unknown;
  producers: { participantId: string; producerId: string }[];
}

/** server→client: op `voice.transport` — created transport params (Device.create*Transport). */
export interface VoiceTransportPayload {
  direction: "send" | "recv";
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown;
  dtlsParameters: unknown;
}

/** server→client: op `voice.connected` — ack of `voice.connect`. */
export interface VoiceConnectedPayload {
  direction: "send" | "recv";
}

/** server→client: op `voice.produced` — ack of `voice.produce`: this socket's producer id. */
export interface VoiceProducedPayload {
  producerId: string;
}

/** server→client: op `voice.consumer` — consume params (transport.consume input); created paused. */
export interface VoiceConsumerPayload {
  id: string;
  producerId: string;
  kind: "audio";
  rtpParameters: unknown;
}

/** server→client: op `voice.resumed` — ack of `voice.resume`. */
export interface VoiceResumedPayload {
  producerId: string;
}

/** server→client: op `voice.new_producer` — a peer started producing; consume it. */
export interface VoiceNewProducerPayload {
  participantId: string;
  producerId: string;
}

/** server→client: op `voice.peer_left` — a peer left/disconnected; drop its consumer/<audio>. */
export interface VoicePeerLeftPayload {
  participantId: string;
}

/** server→client: op `voice.state` — a peer's mute/deafen changed (relay). */
export interface VoiceStateUpdatePayload {
  userId: number;
  participantId: string;
  muted: boolean;
  deafened: boolean;
}

/** server→client: op `voice.error` — a voice op failed (never closes the socket). */
export interface VoiceErrorPayload {
  op: string;
  message: string;
}

/** Discriminated union of every server→client event the gateway emits. */
export type ServerEvent =
  | Envelope<"ready", ReadyPayload>
  | Envelope<"presence.update", PresenceUpdatePayload>
  | Envelope<"user.update", UserUpdatePayload>
  | Envelope<"message.create", MessageCreatePayload>
  | Envelope<"channel.create", ChannelCreatePayload>
  | Envelope<"voice.joined", VoiceJoinedPayload>
  | Envelope<"voice.transport", VoiceTransportPayload>
  | Envelope<"voice.connected", VoiceConnectedPayload>
  | Envelope<"voice.produced", VoiceProducedPayload>
  | Envelope<"voice.consumer", VoiceConsumerPayload>
  | Envelope<"voice.resumed", VoiceResumedPayload>
  | Envelope<"voice.new_producer", VoiceNewProducerPayload>
  | Envelope<"voice.peer_left", VoicePeerLeftPayload>
  | Envelope<"voice.state", VoiceStateUpdatePayload>
  | Envelope<"voice.error", VoiceErrorPayload>;

/** Discriminated union of every client→server command the gateway accepts. */
export type ClientCommand =
  | Envelope<"identify", IdentifyPayload>
  | Envelope<"message.send", MessageSendPayload>
  | Envelope<"voice.join", VoiceJoinPayload>
  | Envelope<"voice.transport", VoiceTransportRequestPayload>
  | Envelope<"voice.connect", VoiceConnectPayload>
  | Envelope<"voice.produce", VoiceProducePayload>
  | Envelope<"voice.consume", VoiceConsumePayload>
  | Envelope<"voice.resume", VoiceResumePayload>
  | Envelope<"voice.state", VoiceStatePayload>
  | Envelope<"voice.leave", VoiceLeavePayload>;
