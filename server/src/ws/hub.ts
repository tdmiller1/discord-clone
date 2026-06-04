import type { WebSocket } from "@fastify/websocket";
import type { Envelope } from "../types.js";

/**
 * Flat in-memory broadcast hub: a `Set<socket>` of every authed socket. Unlike
 * {@link ./presence.ts PresenceRegistry} (keyed by `userId`, presence-scoped),
 * this is keyed only by socket so it can back a cross-plugin broadcast helper
 * (`app.broadcast`) without leaking the presence map to the REST layer (story 003).
 *
 * Constructed once in `buildApp`, shared with the gateway (which adds/removes each
 * authed socket) and decorated on `app` so the REST layer can emit `channel.create`.
 * Blessed by the story for ≤10 clients — no message broker.
 */
export class BroadcastHub {
  readonly #sockets = new Set<WebSocket>();

  /** Registers a socket so it receives broadcasts. Idempotent (`Set` semantics). */
  add(socket: WebSocket): void {
    this.#sockets.add(socket);
  }

  /** Deregisters a socket. Idempotent — it may fire on both `close` and `error`. */
  remove(socket: WebSocket): void {
    this.#sockets.delete(socket);
  }

  /**
   * Serializes `env` once and sends it to every tracked socket whose readyState is
   * OPEN, skipping `except`. Defined as a bound arrow method so `app.decorate(
   * "broadcast", hub.broadcast)` keeps `this`.
   */
  broadcast = (env: Envelope, except?: WebSocket): void => {
    const payload = JSON.stringify(env);
    for (const socket of this.#sockets) {
      if (socket === except) continue;
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  };
}
