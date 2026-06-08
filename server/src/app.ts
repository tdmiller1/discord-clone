import Fastify, { type FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { mkdirSync } from "node:fs";
import { type Config, imagesDir } from "./config.js";
import { openDatabase, type Db } from "./db.js";
import { seedVoiceChannel } from "./channels.js";
import authRoutes from "./routes/auth.js";
import channelRoutes from "./routes/channels.js";
import attachmentRoutes from "./routes/attachments.js";
import wsGateway from "./ws/gateway.js";
import { BroadcastHub } from "./ws/hub.js";
import { VoiceRegistry } from "./ws/voice-registry.js";
import { VoiceSfu } from "./voice/sfu.js";
import type { Envelope, PublicUser, SessionRow } from "./types.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    /** Sends a `{ op, d }` envelope to every authed WS socket (skipping `except`). */
    broadcast: (env: Envelope, except?: WebSocket) => void;
  }
  interface FastifyRequest {
    /** Set by the `requireAuth` preHandler on authenticated routes. */
    user?: PublicUser;
    /** Set by the `requireAuth` preHandler on authenticated routes. */
    session?: SessionRow;
  }
}

/**
 * Builds the Fastify application. Kept separate from {@link ./index.ts} so it can
 * be constructed in tests without binding a port.
 *
 * M0 exposes only health/info routes. Auth, channels, messages, images and the
 * WebSocket gateway are added in later milestones (see SPEC.md §6–§11).
 */
export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "production" ? "info" : "debug",
    },
  });

  // Permissive CORS so the desktop webview (tauri://localhost, http://localhost:1420)
  // can call the API. Tighten the allowed origins later if needed (SPEC.md §12).
  void app.register(cors, { origin: true });

  // Open/create the SQLite store and expose it to later route plugins as app.db.
  const db = openDatabase(config);
  app.decorate("db", db);
  app.addHook("onClose", async () => {
    db.close();
  });

  // Seed the single v1 voice channel idempotently — SPEC.md §13.3; reseeding on
  // restart is a no-op. Done before route/gateway registration so the voice row
  // exists prior to any client connecting or any `ready` snapshot being built.
  seedVoiceChannel(db);

  // Ensure the image-upload directory exists on boot (mirrors db.ts's data-dir
  // creation) so the upload route never races directory creation (SPEC.md §10).
  mkdirSync(imagesDir(config), { recursive: true });

  // Flat all-sockets broadcast hub, constructed at app level (not inside a plugin)
  // so it is visible to both the gateway and the REST layer; `app.broadcast` lets
  // the REST channel route (story 003) push `channel.create` to every client.
  const hub = new BroadcastHub();
  app.decorate("broadcast", hub.broadcast);

  // mediasoup SFU core (SPEC.md §11): one worker + Opus router, constructed once and
  // shared. Async-initialized here so a worker bind failure fails the boot fast. The
  // gateway relays it for the `voice.*` ops (story 003).
  const sfu = new VoiceSfu(config);
  await sfu.init();
  app.addHook("onClose", async () => {
    await sfu.close();
  });

  // In-memory voice-membership registry (mirrors PresenceRegistry): tracks each
  // socket's live `voiceChannelId` and reports per-user join/leave transitions so
  // the gateway broadcasts `presence.update` and `buildReady` reports live voice.
  const voice = new VoiceRegistry();

  // Rate limiting, registered non-global so only the opted-in auth routes
  // (register/login) are throttled; authenticated traffic is untouched (SPEC.md §12).
  void app.register(rateLimit, {
    global: false,
    max: config.authRateMax,
    timeWindow: config.authRateWindowMs,
  });

  // Auth REST endpoints (register/login/logout/refresh). Config is passed via the
  // register options so handlers can read the session TTL and rate-limit knobs.
  void app.register(authRoutes, { config });

  // Multipart parser for image uploads, capped at MAX_UPLOAD_MB so oversized
  // uploads are rejected by the framework rather than buffered unboundedly
  // (SPEC.md §10). Registered before the attachment routes that consume it.
  void app.register(multipart, {
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  });

  // Channel REST endpoints: create channel + message history (SPEC.md §9).
  void app.register(channelRoutes, { config });

  // Attachment REST endpoints: image upload + auth-checked download (SPEC.md §10).
  void app.register(attachmentRoutes, { config });

  // WebSocket gateway (SPEC.md §7): connect-time auth via the first `identify`
  // frame, `ready` snapshot, and live `presence.update` broadcasts.
  void app.register(wsGateway, { config, hub, sfu, voice });

  app.get("/health", async () => ({
    status: "ok",
    service: "discord-clone-server",
  }));

  app.get("/", async () => ({
    name: "discord-clone-server",
    version: "0.3.0",
    docs: "See SPEC.md",
  }));

  return app;
}
