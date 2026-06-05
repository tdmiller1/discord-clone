import type { WebSocket } from "@fastify/websocket";

/**
 * In-memory voice-membership registry: `Map<userId, Map<socket, channelId>>`. A
 * user is "in voice" iff at least one of their sockets is in a voice channel.
 * Mirrors {@link ./presence.ts PresenceRegistry} — a plain class with `#private`
 * fields, framework-agnostic, blessed by the feature for ≤10 clients.
 *
 * `add`/`remove` report whether the user's in-voice state just flipped so the
 * gateway broadcasts `presence.update` (with the live `voiceChannelId`) exactly
 * once on the per-user first-in / last-out transition, mirroring online/offline.
 */
export class VoiceRegistry {
  readonly #map = new Map<number, Map<WebSocket, number>>();

  /**
   * Records that `socket` (owned by `userId`) joined `channelId`. Returns
   * `firstInVoice` true if the user had no in-voice socket before.
   */
  add(
    userId: number,
    socket: WebSocket,
    channelId: number,
  ): { firstInVoice: boolean } {
    let sockets = this.#map.get(userId);
    const firstInVoice = sockets === undefined || sockets.size === 0;
    if (sockets === undefined) {
      sockets = new Map();
      this.#map.set(userId, sockets);
    }
    sockets.set(socket, channelId);
    return { firstInVoice };
  }

  /**
   * Removes `socket` for `userId`. Returns `lastInVoice` true if that was the
   * user's last in-voice socket, plus the `channelId` it was in (or `null` if the
   * socket was not tracked). Idempotent for unknown user/socket (it may fire on
   * `voice.leave`, `close`, `error`, and the heartbeat reaper path).
   */
  remove(
    userId: number,
    socket: WebSocket,
  ): { lastInVoice: boolean; channelId: number | null } {
    const sockets = this.#map.get(userId);
    if (sockets === undefined) return { lastInVoice: false, channelId: null };
    const channelId = sockets.get(socket);
    if (channelId === undefined) return { lastInVoice: false, channelId: null };
    sockets.delete(socket);
    if (sockets.size === 0) {
      this.#map.delete(userId);
      return { lastInVoice: true, channelId };
    }
    return { lastInVoice: false, channelId };
  }

  /**
   * The voice channel `userId` is in if any of their sockets is in voice, else
   * `null`. Used by `buildReady` to report live `voiceChannelId`.
   */
  voiceChannelOf(userId: number): number | null {
    const sockets = this.#map.get(userId);
    if (sockets === undefined || sockets.size === 0) return null;
    for (const channelId of sockets.values()) return channelId;
    return null;
  }
}
