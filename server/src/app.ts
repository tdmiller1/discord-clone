import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { Config } from "./config.js";

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
