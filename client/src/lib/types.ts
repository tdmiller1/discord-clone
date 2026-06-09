/** Client mirrors of the story-003 auth-api contract shapes (camelCase, epoch-ms numbers). */

/** The only user shape the server returns (password_hash and disabled are omitted). */
export interface PublicUser {
  id: number;
  username: string;
  displayName: string | null;
  createdAt: number;
  /** Attachment id of the current profile picture, or null. The bytes are fetched
   * from GET /api/attachments/:id like any inline image (see attachmentImages.ts). */
  avatarId: number | null;
}

/** Body returned by POST /api/register, /api/login, and /api/refresh. */
export interface SessionResponse {
  session: string; // raw opaque token (Bearer + WS connect credential)
  expiresAt: number; // epoch ms
  user: PublicUser;
}

/* WS gateway frame shapes — mirrors server/src/types.ts + the story-004 WS contract. */

/** Live presence state of a user (SPEC.md §7). */
export type PresenceStatus = "online" | "offline";

/** A user as it appears in `ready.members`: PublicUser + live presence. */
export interface Member extends PublicUser {
  status: PresenceStatus;
  voiceChannelId: number | null; // the voice channel the user is in, or null when not in voice (M4)
}

/** A text/voice channel as it appears in `ready.channels` and `channel.create` (story 002/003). */
export interface PublicChannel {
  id: number;
  name: string;
  type: "text" | "voice";
  position: number;
  createdBy: number | null;
  createdAt: number;
}

/** server→client: op `ready` (sent once after a successful `identify`). */
export interface ReadyPayload {
  user: PublicUser;
  channels: PublicChannel[]; // text/voice channels (story 002)
  members: Member[];
}

/** An uploaded image attachment as embedded in a message (story 002/003). No baked `url` —
 * the client fetches bytes from GET /api/attachments/:id using `id`. */
export interface PublicAttachment {
  id: number;
  messageId: number | null;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  createdAt: number; // epoch ms
}

/** A persisted message as it appears in history (story 003) and `message.create` (story 002). */
export interface PublicMessage {
  id: number;
  channelId: number;
  authorId: number;
  content: string;
  attachment: PublicAttachment | null;
  createdAt: number; // epoch ms
}

/** server→client: op `channel.create` (broadcast on POST /api/channels, story 002/003). */
export interface ChannelCreatePayload {
  channel: PublicChannel;
}

/** server→client: op `message.create` (broadcast to all authed sockets, story 002). */
export interface MessageCreatePayload {
  message: PublicMessage;
}

/** server→client: op `presence.update`. */
export interface PresenceUpdatePayload {
  userId: number;
  status: PresenceStatus;
  voiceChannelId: number | null; // the voice channel the user is in, or null when not in voice (M4)
}

/** server→client: op `user.update` — a user changed their profile (username or avatar).
 * Merge the new PublicUser into the member map, preserving live presence (status/voiceChannelId). */
export interface UserUpdatePayload {
  user: PublicUser;
}

/* ── Voice (M4) WS payloads — mirror story-003 contracts/voice-protocol.md verbatim.
 * mediasoup param objects (rtpCapabilities, iceParameters, iceCandidates, dtlsParameters,
 * rtpParameters) pass through `unknown` at the gateway boundary; the voice engine casts them
 * into mediasoup-client's typed APIs at the call site. */

/** client→server: voice.join — join the seeded voice channel. */
export interface VoiceJoinPayload {
  channelId: number;
}

/** client→server: voice.transport — request a send|recv transport (once per direction). */
export interface VoiceTransportRequestPayload {
  direction: "send" | "recv";
}

/** client→server: voice.connect — complete DTLS for the named transport. */
export interface VoiceConnectPayload {
  direction: "send" | "recv";
  dtlsParameters: unknown;
}

/** client→server: voice.produce — publish the mic track (over the send transport). */
export interface VoiceProducePayload {
  rtpParameters: unknown;
}

/** client→server: voice.consume — consume a remote producer (server replies with a paused consumer). */
export interface VoiceConsumePayload {
  producerId: string;
  rtpCapabilities: unknown;
}

/** client→server: voice.resume — resume a consumer after wiring its receiving side. */
export interface VoiceResumePayload {
  producerId: string;
}

/** client→server: voice.state — mute/deafen toggle (deafened is local playback only). */
export interface VoiceStatePayload {
  muted: boolean;
  deafened?: boolean;
}

/** client→server: voice.leave — leave the voice channel (no fields). */
export interface VoiceLeavePayload {}

/** server→client: voice.joined — ack of voice.join (router caps + existing producers). */
export interface VoiceJoinedPayload {
  channelId: number;
  participantId: string;
  rtpCapabilities: unknown; // → Device.load({ routerRtpCapabilities })
  producers: { participantId: string; producerId: string; userId: number | null }[];
}

/** server→client: voice.transport — created transport params → createSend/RecvTransport(...). */
export interface VoiceTransportPayload {
  direction: "send" | "recv";
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown;
  dtlsParameters: unknown;
}

/** server→client: voice.connected — ack of voice.connect (resolve the transport "connect" event). */
export interface VoiceConnectedPayload {
  direction: "send" | "recv";
}

/** server→client: voice.produced — ack of voice.produce (resolve the transport "produce" event). */
export interface VoiceProducedPayload {
  producerId: string;
}

/** server→client: voice.consumer — consume params → recvTransport.consume(...); created PAUSED. */
export interface VoiceConsumerPayload {
  id: string;
  producerId: string;
  kind: "audio";
  rtpParameters: unknown;
}

/** server→client: voice.resumed — ack of voice.resume. */
export interface VoiceResumedPayload {
  producerId: string;
}

/** server→client: voice.new_producer — a peer started producing; issue a voice.consume for it. */
export interface VoiceNewProducerPayload {
  participantId: string;
  producerId: string;
  userId: number | null; // the peer's user id, so the client resolves a username without waiting for voice.state
}

/** server→client: voice.peer_left — a peer left/disconnected; close its consumer / drop its audio. */
export interface VoicePeerLeftPayload {
  participantId: string;
}

/** server→client: voice.state — a peer's mute/deafen changed (relay for UI). */
export interface VoiceStateUpdatePayload {
  userId: number;
  participantId: string;
  muted: boolean;
  deafened: boolean;
}

/** server→client: voice.error — a voice op failed for this socket (socket stays open). */
export interface VoiceErrorPayload {
  op: string;
  message: string;
}

/** Generic realtime WS envelope (SPEC.md §7). */
export interface Envelope<Op extends string = string, D = unknown> {
  op: Op;
  d: D;
}

/** Discriminated union of every server→client frame the gateway emits. */
export type ServerFrame =
  | Envelope<"ready", ReadyPayload>
  | Envelope<"presence.update", PresenceUpdatePayload>
  | Envelope<"user.update", UserUpdatePayload>
  | Envelope<"channel.create", ChannelCreatePayload>
  | Envelope<"message.create", MessageCreatePayload>
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
