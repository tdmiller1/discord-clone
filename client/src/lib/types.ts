/** Client mirrors of the story-003 auth-api contract shapes (camelCase, epoch-ms numbers). */

/** The only user shape the server returns (password_hash and disabled are omitted). */
export interface PublicUser {
  id: number;
  username: string;
  displayName: string | null;
  createdAt: number;
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
  voiceChannelId: number | null; // always null in M1 (voice arrives M4)
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

/** server→client: op `channel.create` (broadcast on POST /api/channels, story 002/003). */
export interface ChannelCreatePayload {
  channel: PublicChannel;
}

/** server→client: op `presence.update`. */
export interface PresenceUpdatePayload {
  userId: number;
  status: PresenceStatus;
  voiceChannelId: number | null; // always null in M1 (ignored)
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
  | Envelope<"channel.create", ChannelCreatePayload>;
