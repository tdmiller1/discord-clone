import { randomUUID } from "node:crypto";
import websocket, { type WebSocket } from "@fastify/websocket";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { RawData } from "ws";
import { getAttachmentById, linkAttachmentToMessage } from "../attachments.js";
import { authenticateSession } from "../auth.js";
import {
  getChannelById,
  getMessageWithAttachment,
  getVoiceChannel,
  insertMessage,
  listChannels,
  updateMessageContent,
} from "../channels.js";
import type { Config } from "../config.js";
import {
  toPublicChannel,
  toPublicMessage,
  toPublicUser,
  type AttachmentRow,
  type Envelope,
  type Member,
  type ReadyPayload,
  type UserRow,
} from "../types.js";
import type { types } from "mediasoup";
import type { TransportDirection, VoiceSfu } from "../voice/sfu.js";
import { BroadcastHub } from "./hub.js";
import { PresenceRegistry } from "./presence.js";
import { VoiceRegistry } from "./voice-registry.js";

interface WsGatewayOptions {
  config: Config;
  hub: BroadcastHub;
  sfu: VoiceSfu;
  voice: VoiceRegistry;
}

/** Mutable per-connection state held alongside each live socket. */
interface ConnState {
  userId: number | null;
  /** Raw session token captured at `identify`; re-validated by the heartbeat reaper. */
  token: string | null;
  /** Cleared on each ping, set on `pong`; a full interval at false means the socket is dead. */
  isAlive: boolean;
  authed: boolean;
  /** Timer that closes the socket if a valid `identify` never arrives. */
  deadline: NodeJS.Timeout | null;
  /** Per-socket SFU participant id, minted on the first `voice.join` (reused on re-join). */
  participantId: string | null;
  /** The voice channel this socket is currently in, or `null` if not in voice. */
  voiceChannelId: number | null;
}

/** Gateway route path (SPEC.md §7). */
const WS_PATH = "/ws";
/** Inbound frame cap (`ws` `maxPayload` + a defensive guard). */
const WS_MAX_FRAME_BYTES = 64 * 1024;
/** Ping interval / max staleness before a silent socket is terminated. */
const WS_HEARTBEAT_MS = 30_000;
/** Time a fresh socket has to send a valid `identify` before it is closed. */
const WS_AUTH_DEADLINE_MS = 10_000;
/** Single auth-failure close code (private 4000–4999 range): missing/invalid/expired/revoked/disabled. */
const WS_CLOSE_UNAUTHORIZED = 4001;
/** Oversize inbound frame (mirrors `ws`'s own behavior). */
const WS_CLOSE_TOO_LARGE = 1009;

/** Normalizes a `ws` frame (Buffer, fragmented Buffer[], or ArrayBuffer) to a single Buffer. */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Extracts a `"send"|"recv"` transport direction from a voice frame's `d`, or `null` if invalid. */
function parseDirection(d: unknown): TransportDirection | null {
  if (typeof d !== "object" || d === null) return null;
  const direction = (d as { direction?: unknown }).direction;
  if (direction === "send" || direction === "recv") return direction;
  return null;
}

/**
 * WebSocket gateway (SPEC.md §7). Authenticates on the first `identify` frame by
 * reusing {@link authenticateSession} (story 003), sends a `ready` snapshot, and
 * broadcasts `presence.update` on first-online / last-offline transitions.
 *
 * An in-memory {@link PresenceRegistry} (`Map<userId, Set<socket>>`) plus a single
 * heartbeat interval handle dead-socket detection and double as the revocation
 * reaper — each tick re-validates every authed socket's session, so CLI-side
 * `revoke-user` (a separate process that only mutates SQLite) is picked up without
 * any IPC. Voice signaling (`voice.*`) relays the SFU core (story 002) over the
 * same socket and tracks voice membership via an in-memory {@link VoiceRegistry}.
 */
const wsGateway: FastifyPluginAsync<WsGatewayOptions> = async (
  app: FastifyInstance,
  opts: WsGatewayOptions,
) => {
  const { config, hub, sfu, voice } = opts;
  await app.register(websocket, {
    options: { maxPayload: WS_MAX_FRAME_BYTES },
  });

  const db = app.db;
  const registry = new PresenceRegistry();
  /** Every live socket and its mutable state; the heartbeat sweeps this. */
  const sockets = new Map<WebSocket, ConnState>();

  /** Builds the `ready` snapshot for `user`: every channel + every non-disabled user with live status. */
  const buildReady = (user: ReadyPayload["user"]): ReadyPayload => {
    const rows = db
      .prepare("SELECT * FROM users WHERE disabled = 0")
      .all() as UserRow[];
    const members: Member[] = rows.map((row) => ({
      ...toPublicUser(row),
      status: registry.isOnline(row.id) ? "online" : "offline",
      voiceChannelId: voice.voiceChannelOf(row.id),
    }));
    const channels = listChannels(db).map(toPublicChannel);
    return { user, channels, members };
  };

  /**
   * Resolves the userId that owns an SFU participant id by scanning live sockets
   * (≤10 clients — a linear scan like `broadcastToRoom`). Lets the join-path frames
   * (`voice.joined.producers`, `voice.new_producer`) carry the peer's userId so the
   * client resolves a username immediately instead of showing the raw participant
   * UUID until a `voice.state` (mute/deafen) happens to arrive. Null if no live
   * socket currently holds it.
   */
  const userIdForParticipant = (participantId: string): number | null => {
    for (const st of sockets.values()) {
      if (st.participantId === participantId) return st.userId;
    }
    return null;
  };

  app.get(WS_PATH, { websocket: true }, (socket: WebSocket) => {
    const state: ConnState = {
      userId: null,
      token: null,
      isAlive: true,
      authed: false,
      deadline: null,
      participantId: null,
      voiceChannelId: null,
    };
    sockets.set(socket, state);

    /** Sends a `{ op, d }` envelope to this socket if it is still OPEN. */
    const send = (env: Envelope): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(env));
    };

    /**
     * Sends `env` to every *other* socket currently in voice `channelId` (the
     * room-scoped fan-out for `voice.new_producer` / `voice.peer_left` /
     * `voice.state`). `except` is excluded (e.g. the originating socket).
     */
    const broadcastToRoom = (
      channelId: number,
      env: Envelope,
      except?: WebSocket,
    ): void => {
      const payload = JSON.stringify(env);
      for (const [s, st] of sockets) {
        if (s === except) continue;
        if (st.voiceChannelId === channelId && s.readyState === s.OPEN) {
          s.send(payload);
        }
      }
    };

    /**
     * Single voice-exit path shared by `voice.leave` and `teardown()` (covers
     * leave, socket close, error, and the heartbeat reaper). Idempotent: a no-op
     * if this socket is not in voice. Closes the SFU participant, notifies room
     * peers to drop its consumer (`voice.peer_left`), and broadcasts
     * `presence.update {voiceChannelId:null}` on the per-user last-in-voice
     * transition. `participantId` is intentionally NOT reset so a leave-then-rejoin
     * on the same socket reuses it.
     */
    const leaveVoice = (): void => {
      if (state.voiceChannelId === null || state.participantId === null) return;
      const channelId = state.voiceChannelId;
      const participantId = state.participantId;
      sfu.closeParticipant(channelId, participantId);
      // Notify peers BEFORE clearing `voiceChannelId` so the room filter matches;
      // the leaver excludes itself via `except`.
      broadcastToRoom(
        channelId,
        { op: "voice.peer_left", d: { participantId } },
        socket,
      );
      state.voiceChannelId = null;
      const { lastInVoice } = voice.remove(state.userId!, socket);
      if (lastInVoice) {
        registry.broadcast(
          {
            op: "presence.update",
            d: { userId: state.userId, status: "online", voiceChannelId: null },
          },
          socket,
        );
      }
    };

    /**
     * Dispatches an authed `voice.*` op. Each branch validates its `d` defensively
     * (tolerant: malformed → `return`, never closes the socket, mirroring
     * `message.send`); SFU throws on unknown channel/participant are caught by the
     * caller's `.catch()` and answered with `voice.error`. Unknown `voice.*` ops
     * fall through to a no-op.
     */
    const handleVoice = async (op: string, d: unknown): Promise<void> => {
      switch (op) {
        case "voice.join": {
          if (typeof d !== "object" || d === null) return;
          const channelId = (d as { channelId?: unknown }).channelId;
          if (typeof channelId !== "number" || !Number.isFinite(channelId)) {
            return;
          }
          const vc = getVoiceChannel(db);
          if (!vc || vc.id !== channelId) {
            send({
              op: "voice.error",
              d: { op, message: "not a voice channel" },
            });
            return;
          }
          // Idempotent re-join: reuse the existing participant id; otherwise mint
          // one. The SFU's own idempotency prevents a second mic track.
          if (state.participantId === null) {
            state.participantId = randomUUID();
          }
          const participantId = state.participantId;
          const firstJoin = state.voiceChannelId !== channelId;
          state.voiceChannelId = channelId;
          let firstInVoice = false;
          if (firstJoin) {
            ({ firstInVoice } = voice.add(state.userId!, socket, channelId));
          }
          send({
            op: "voice.joined",
            d: {
              channelId,
              participantId,
              rtpCapabilities: sfu.getRtpCapabilities(),
              producers: sfu
                .listProducers(channelId, participantId)
                .map((p) => ({ ...p, userId: userIdForParticipant(p.participantId) })),
            },
          });
          if (firstInVoice) {
            registry.broadcast(
              {
                op: "presence.update",
                d: {
                  userId: state.userId,
                  status: "online",
                  voiceChannelId: channelId,
                },
              },
              socket,
            );
          }
          return;
        }

        case "voice.transport": {
          if (state.voiceChannelId === null || state.participantId === null) {
            send({ op: "voice.error", d: { op, message: "not in voice" } });
            return;
          }
          const direction = parseDirection(d);
          if (direction === null) return;
          const params = await sfu.createTransport(
            state.voiceChannelId,
            state.participantId,
            direction,
          );
          send({ op: "voice.transport", d: { direction, ...params } });
          return;
        }

        case "voice.connect": {
          if (state.voiceChannelId === null || state.participantId === null) {
            send({ op: "voice.error", d: { op, message: "not in voice" } });
            return;
          }
          const direction = parseDirection(d);
          if (direction === null) return;
          const dtlsParameters = (d as { dtlsParameters?: unknown })
            .dtlsParameters;
          if (typeof dtlsParameters !== "object" || dtlsParameters === null) {
            return;
          }
          await sfu.connectTransport(
            state.voiceChannelId,
            state.participantId,
            direction,
            dtlsParameters as types.DtlsParameters,
          );
          send({ op: "voice.connected", d: { direction } });
          return;
        }

        case "voice.produce": {
          if (state.voiceChannelId === null || state.participantId === null) {
            send({ op: "voice.error", d: { op, message: "not in voice" } });
            return;
          }
          if (typeof d !== "object" || d === null) return;
          const rtpParameters = (d as { rtpParameters?: unknown }).rtpParameters;
          if (typeof rtpParameters !== "object" || rtpParameters === null) {
            return;
          }
          const { producerId } = await sfu.produce(
            state.voiceChannelId,
            state.participantId,
            rtpParameters as types.RtpParameters,
          );
          send({ op: "voice.produced", d: { producerId } });
          broadcastToRoom(
            state.voiceChannelId,
            {
              op: "voice.new_producer",
              d: { participantId: state.participantId, producerId, userId: state.userId },
            },
            socket,
          );
          return;
        }

        case "voice.consume": {
          if (state.voiceChannelId === null || state.participantId === null) {
            send({ op: "voice.error", d: { op, message: "not in voice" } });
            return;
          }
          if (typeof d !== "object" || d === null) return;
          const producerId = (d as { producerId?: unknown }).producerId;
          if (typeof producerId !== "string") return;
          const rtpCapabilities = (d as { rtpCapabilities?: unknown })
            .rtpCapabilities;
          if (typeof rtpCapabilities !== "object" || rtpCapabilities === null) {
            return;
          }
          const params = await sfu.consume(
            state.voiceChannelId,
            state.participantId,
            producerId,
            rtpCapabilities as types.RtpCapabilities,
          );
          // null = incompatible caps (`!router.canConsume`) — skip silently.
          if (params === null) return;
          send({ op: "voice.consumer", d: { ...params } });
          return;
        }

        case "voice.resume": {
          if (state.voiceChannelId === null || state.participantId === null) {
            send({ op: "voice.error", d: { op, message: "not in voice" } });
            return;
          }
          if (typeof d !== "object" || d === null) return;
          const producerId = (d as { producerId?: unknown }).producerId;
          if (typeof producerId !== "string") return;
          await sfu.resumeConsumer(
            state.voiceChannelId,
            state.participantId,
            producerId,
          );
          send({ op: "voice.resumed", d: { producerId } });
          return;
        }

        case "voice.state": {
          if (state.voiceChannelId === null || state.participantId === null) {
            send({ op: "voice.error", d: { op, message: "not in voice" } });
            return;
          }
          if (typeof d !== "object" || d === null) return;
          const muted = (d as { muted?: unknown }).muted;
          if (typeof muted !== "boolean") return;
          const rawDeafened = (d as { deafened?: unknown }).deafened;
          if (rawDeafened !== undefined && typeof rawDeafened !== "boolean") {
            return;
          }
          const deafened = rawDeafened ?? false;
          // `pauseProducer`/`resumeProducer` are idempotent no-ops if there is no
          // producer, so rapid toggles and mic-less joins converge safely.
          if (muted) {
            sfu.pauseProducer(state.voiceChannelId, state.participantId);
          } else {
            sfu.resumeProducer(state.voiceChannelId, state.participantId);
          }
          // `deafened` is local playback only — relayed but no server media change.
          broadcastToRoom(
            state.voiceChannelId,
            {
              op: "voice.state",
              d: {
                userId: state.userId,
                participantId: state.participantId,
                muted,
                deafened,
              },
            },
            socket,
          );
          return;
        }

        case "voice.leave": {
          leaveVoice();
          return;
        }

        default:
          return; // unknown voice op — ignored safely
      }
    };

    let toreDown = false;
    const teardown = (): void => {
      if (toreDown) return;
      toreDown = true;
      if (state.deadline !== null) {
        clearTimeout(state.deadline);
        state.deadline = null;
      }
      // Release any SFU/voice resources first (idempotent if never in voice) so a
      // socket close/error/reap drops the participant and notifies room peers
      // before the online/offline presence step.
      if (state.authed && state.userId !== null) leaveVoice();
      sockets.delete(socket);
      hub.remove(socket);
      if (state.authed && state.userId !== null) {
        const { lastOffline } = registry.remove(state.userId, socket);
        if (lastOffline) {
          registry.broadcast({
            op: "presence.update",
            d: { userId: state.userId, status: "offline", voiceChannelId: null },
          });
        }
      }
    };

    // Unauthenticated until a valid `identify` arrives; close if it never does.
    state.deadline = setTimeout(() => {
      socket.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
    }, WS_AUTH_DEADLINE_MS);

    socket.on("message", (raw: RawData) => {
      const data = toBuffer(raw);
      // Defensive size guard in case `maxPayload` is ever bypassed (`ws` also
      // auto-closes oversize frames with 1009).
      if (data.length > WS_MAX_FRAME_BYTES) {
        socket.close(WS_CLOSE_TOO_LARGE, "frame too large");
        return;
      }

      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return; // malformed JSON — swallow, never crash the connection
      }
      if (typeof frame !== "object" || frame === null) return;
      const op = (frame as { op?: unknown }).op;
      if (typeof op !== "string") return;

      if (!state.authed) {
        // Pre-auth: only `identify` is honored; anything else is ignored and the
        // deadline still governs.
        if (op !== "identify") return;
        const d = (frame as { d?: unknown }).d;
        const token =
          typeof d === "object" && d !== null
            ? (d as { token?: unknown }).token
            : undefined;
        if (typeof token !== "string") {
          socket.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
          return;
        }
        const result = authenticateSession(db, token);
        if (!result) {
          // No `ready`, single opaque close code (mirrors the REST uniform 401).
          socket.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
          return;
        }
        if (state.deadline !== null) {
          clearTimeout(state.deadline);
          state.deadline = null;
        }
        state.authed = true;
        state.userId = result.user.id;
        state.token = token;

        // Add to the registry FIRST so the joiner sees itself online in `ready`,
        // then snapshot members, then notify others exactly once. Register in the
        // broadcast hub too so this socket receives `message.create`/`channel.create`.
        const { firstOnline } = registry.add(result.user.id, socket);
        hub.add(socket);
        socket.send(JSON.stringify({ op: "ready", d: buildReady(result.user) }));
        if (firstOnline) {
          registry.broadcast(
            {
              op: "presence.update",
              d: {
                userId: result.user.id,
                status: "online",
                voiceChannelId: null,
              },
            },
            socket,
          );
        }
        return;
      }

      // Post-auth voice signaling (`voice.*`). SFU methods are async, so route into
      // `handleVoice` and `.catch()` so a rejected SFU call never becomes an
      // unhandled rejection or crashes the socket — it is logged and surfaced as a
      // `voice.error` frame to the requesting socket.
      if (op.startsWith("voice.")) {
        const d = (frame as { d?: unknown }).d;
        void handleVoice(op, d).catch((err: unknown) => {
          app.log.error(err);
          send({ op: "voice.error", d: { op, message: "voice operation failed" } });
        });
        return;
      }

      // `message.edit` — the author rewrites their own message's text. Validate the
      // payload, enforce ownership, then re-broadcast the row as `message.update` so
      // every client (incl. the editor) replaces it in place via upsert-by-id.
      if (op === "message.edit") {
        const d = (frame as { d?: unknown }).d;
        if (typeof d !== "object" || d === null) return;
        const messageId = (d as { messageId?: unknown }).messageId;
        if (
          typeof messageId !== "number" ||
          !Number.isInteger(messageId) ||
          messageId <= 0
        ) {
          return;
        }
        const content = (d as { content?: unknown }).content;
        if (typeof content !== "string") return;
        if (content.length > config.maxMessageLength) return;
        const existing = getMessageWithAttachment(db, messageId);
        if (!existing) return;
        // Authors may only edit their OWN messages (the core ownership gate).
        if (existing.message.author_id !== state.userId) return;
        const trimmed = content.trim();
        // Empty content is only allowed when an attachment still carries the message
        // (mirrors the image-only rule in `message.send`); never blank out a text post.
        if (trimmed.length === 0 && existing.attachment === null) return;
        updateMessageContent(db, messageId, content);
        const result = getMessageWithAttachment(db, messageId);
        if (!result) return;
        hub.broadcast({
          op: "message.update",
          d: { message: toPublicMessage(result.message, result.attachment) },
        });
        return;
      }

      // Post-auth: `message.send` is the remaining in-scope inbound op. Any other op
      // — including a second `identify` — is ignored safely.
      if (op !== "message.send") return;
      const d = (frame as { d?: unknown }).d;
      if (typeof d !== "object" || d === null) return;
      const channelId = (d as { channelId?: unknown }).channelId;
      if (typeof channelId !== "number" || !Number.isFinite(channelId)) return;
      const content = (d as { content?: unknown }).content;
      if (typeof content !== "string") return;
      const rawAttachmentId = (d as { attachmentId?: unknown }).attachmentId;
      let hasAttachment = false;
      let attachmentId = 0;
      if (rawAttachmentId !== undefined && rawAttachmentId !== null) {
        if (
          typeof rawAttachmentId !== "number" ||
          !Number.isInteger(rawAttachmentId) ||
          rawAttachmentId <= 0
        ) {
          return;
        }
        hasAttachment = true;
        attachmentId = rawAttachmentId;
      }
      const trimmed = content.trim();
      if (content.length > config.maxMessageLength) return;
      // Empty/whitespace content is only allowed when a valid attachment carries
      // the message (image-only); otherwise content is required (M2 rule).
      if (trimmed.length === 0 && !hasAttachment) return;
      if (!getChannelById(db, channelId)) return;
      // Validate the attachment before persisting: it must exist, belong to the
      // sender, and be unlinked (`message_id IS NULL`). `linkAttachmentToMessage`
      // does not check ownership/existence, so this is the authoritative gate; the
      // in-transaction link-once assertion below is the concurrency backstop.
      let attachment: AttachmentRow | undefined;
      if (hasAttachment) {
        attachment = getAttachmentById(db, attachmentId);
        if (
          !attachment ||
          attachment.uploader_id !== state.userId ||
          attachment.message_id !== null
        ) {
          return;
        }
      }
      let messageId: number;
      try {
        messageId = db.transaction(() => {
          const row = insertMessage(db, {
            channelId,
            authorId: state.userId!,
            content,
            attachmentId: hasAttachment ? attachmentId : null,
          });
          if (hasAttachment) {
            const linked = linkAttachmentToMessage(db, attachmentId, row.id);
            if (!linked) throw new Error("attachment link race");
          }
          return row.id;
        })();
      } catch {
        // A link race rolled back the inserted message; drop the frame silently.
        return;
      }
      const result = getMessageWithAttachment(db, messageId);
      if (!result) return;
      // No `except`: the sender gets its own echo so it renders the authoritative row.
      hub.broadcast({
        op: "message.create",
        d: { message: toPublicMessage(result.message, result.attachment) },
      });
    });

    socket.on("pong", () => {
      state.isAlive = true;
    });

    socket.on("close", teardown);
    socket.on("error", teardown);
  });

  // Single heartbeat: dead-socket detection + revocation reaper (≤10 clients).
  const heartbeat = setInterval(() => {
    for (const [socket, state] of sockets) {
      if (!state.isAlive) {
        // A full interval with no pong — treat as dead; its close handler runs
        // teardown, flipping presence offline.
        socket.terminate();
        continue;
      }
      if (state.authed && state.token !== null) {
        // Re-validate so a session revoked out-of-process (CLI `revoke-user`,
        // which only mutates SQLite) is reaped within one interval.
        if (!authenticateSession(db, state.token)) {
          socket.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
          continue;
        }
      }
      state.isAlive = false;
      socket.ping();
    }
  }, WS_HEARTBEAT_MS);

  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    for (const socket of sockets.keys()) socket.terminate();
  });
};

export default wsGateway;
