import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { Config } from "./config.js";
import { openDatabase, type Db } from "./db.js";
import authRoutes from "./routes/auth.js";
import type { PublicUser, SessionRow } from "./types.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
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
export function buildApp(config: Config): FastifyInstance {
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

  app.get("/health", async () => ({
    status: "ok",
    service: "discord-clone-server",
  }));

  app.get("/", async () => ({
    name: "discord-clone-server",
    version: "0.1.0",
    docs: "See SPEC.md",
  }));

  return app;
}
