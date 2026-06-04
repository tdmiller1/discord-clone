import type { WebSocket } from "@fastify/websocket";
import type { Envelope } from "../types.js";

/**
 * In-memory presence registry: `Map<userId, Set<socket>>`. A user is online iff
 * their socket set is non-empty. Blessed by the story/feature for ≤10 clients —
 * no message broker. Framework-agnostic so it can be reasoned about and unit
 * tested independently of the Fastify route plugin.
 *
 * `add`/`remove` report whether the user's online state just flipped so the route
 * layer broadcasts `presence.update` exactly once (on first-online / last-offline).
 */
export class PresenceRegistry {
  readonly #map = new Map<number, Set<WebSocket>>();

  /** Registers a socket for `userId`. Returns `firstOnline` true if the user had no sockets before. */
  add(userId: number, socket: WebSocket): { firstOnline: boolean } {
    let sockets = this.#map.get(userId);
    const firstOnline = sockets === undefined || sockets.size === 0;
    if (sockets === undefined) {
      sockets = new Set();
      this.#map.set(userId, sockets);
    }
    sockets.add(socket);
    return { firstOnline };
  }

  /**
   * Removes a socket for `userId`. Returns `lastOffline` true if that was the
   * user's last socket. Idempotent for unknown user/socket (it may fire on both
   * `close` and `error`).
   */
  remove(userId: number, socket: WebSocket): { lastOffline: boolean } {
    const sockets = this.#map.get(userId);
    if (sockets === undefined) return { lastOffline: false };
    sockets.delete(socket);
    if (sockets.size === 0) {
      this.#map.delete(userId);
      return { lastOffline: true };
    }
    return { lastOffline: false };
  }

  /** True iff `userId` has at least one live socket. */
  isOnline(userId: number): boolean {
    const sockets = this.#map.get(userId);
    return sockets !== undefined && sockets.size > 0;
  }

  /** The set of user ids currently online (≥1 socket). */
  onlineUserIds(): Set<number> {
    return new Set(this.#map.keys());
  }

  /**
   * Serializes `env` once and sends it to every tracked socket whose readyState
   * is OPEN, skipping `except` (e.g. the joining socket, so it never receives its
   * own `presence.update`).
   */
  broadcast(env: Envelope, except?: WebSocket): void {
    const payload = JSON.stringify(env);
    for (const sockets of this.#map.values()) {
      for (const socket of sockets) {
        if (socket === except) continue;
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    }
  }
}
