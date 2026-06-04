import websocket, { type WebSocket } from "@fastify/websocket";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { RawData } from "ws";
import { authenticateSession } from "../auth.js";
import { getChannelById, insertMessage, listChannels } from "../channels.js";
import type { Config } from "../config.js";
import {
  toPublicChannel,
  toPublicMessage,
  toPublicUser,
  type Member,
  type ReadyPayload,
  type UserRow,
} from "../types.js";
import { BroadcastHub } from "./hub.js";
import { PresenceRegistry } from "./presence.js";

interface WsGatewayOptions {
  config: Config;
  hub: BroadcastHub;
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

/**
 * WebSocket gateway (SPEC.md §7). Authenticates on the first `identify` frame by
 * reusing {@link authenticateSession} (story 003), sends a `ready` snapshot, and
 * broadcasts `presence.update` on first-online / last-offline transitions.
 *
 * An in-memory {@link PresenceRegistry} (`Map<userId, Set<socket>>`) plus a single
 * heartbeat interval handle dead-socket detection and double as the revocation
 * reaper — each tick re-validates every authed socket's session, so CLI-side
 * `revoke-user` (a separate process that only mutates SQLite) is picked up without
 * any IPC. Voice ops (`voice.*`) and `message.*` are out of scope until M4/M2.
 */
const wsGateway: FastifyPluginAsync<WsGatewayOptions> = async (
  app: FastifyInstance,
  opts: WsGatewayOptions,
) => {
  const { config, hub } = opts;
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
      voiceChannelId: null,
    }));
    const channels = listChannels(db).map(toPublicChannel);
    return { user, channels, members };
  };

  app.get(WS_PATH, { websocket: true }, (socket: WebSocket) => {
    const state: ConnState = {
      userId: null,
      token: null,
      isAlive: true,
      authed: false,
      deadline: null,
    };
    sockets.set(socket, state);

    let toreDown = false;
    const teardown = (): void => {
      if (toreDown) return;
      toreDown = true;
      if (state.deadline !== null) {
        clearTimeout(state.deadline);
        state.deadline = null;
      }
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

      // Post-auth: `message.send` is the only in-scope inbound op (`voice.*` arrives
      // in M4). Any other op — including a second `identify` — is ignored safely.
      if (op !== "message.send") return;
      const d = (frame as { d?: unknown }).d;
      if (typeof d !== "object" || d === null) return;
      const channelId = (d as { channelId?: unknown }).channelId;
      if (typeof channelId !== "number" || !Number.isFinite(channelId)) return;
      const content = (d as { content?: unknown }).content;
      if (typeof content !== "string") return;
      const trimmed = content.trim();
      if (trimmed.length === 0 || content.length > config.maxMessageLength) {
        return;
      }
      // `attachmentId` is accepted on the wire but ignored in M2 (stored NULL).
      if (!getChannelById(db, channelId)) return;
      const row = insertMessage(db, {
        channelId,
        authorId: state.userId!,
        content,
        attachmentId: null,
      });
      // No `except`: the sender gets its own echo so it renders the authoritative row.
      hub.broadcast({
        op: "message.create",
        d: { message: toPublicMessage(row) },
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
