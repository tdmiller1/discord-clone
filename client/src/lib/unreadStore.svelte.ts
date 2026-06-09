/**
 * Per-channel unread-message tracking (Svelte 5 runes). Lives in a *.svelte.ts
 * module so $state works outside a component, mirroring channelStore.svelte.ts.
 *
 * STUB: the UI (unread dot + count badge in the channel list) is fully wired to
 * this store, but nothing populates it yet — `count()` returns 0 and `has()`
 * returns false for every channel. The future "unread messages" feature plugs in
 * by calling `bump(channelId)` whenever a `message.create` arrives for a channel
 * the user isn't currently viewing, and `markRead(channelId)` on selection. See
 * the TODOs below for the two wiring points (gateway + channelStore.select).
 */

// channelId -> number of unread messages. Absent key == 0 unread.
let _counts = $state<Record<number, number>>({});

export const unreadStore = {
  /** Unread message count for a channel (0 when none / unknown). */
  count(channelId: number): number {
    return _counts[channelId] ?? 0;
  },

  /** Whether a channel has any unread messages. */
  has(channelId: number): boolean {
    return this.count(channelId) > 0;
  },

  /**
   * Increment a channel's unread count by one.
   *
   * TODO(unread): call from the gateway's `message.create` handler when the
   * message's channel != channelStore.activeId (and the window isn't focused).
   */
  bump(channelId: number): void {
    _counts[channelId] = (_counts[channelId] ?? 0) + 1;
  },

  /**
   * Clear a channel's unread count.
   *
   * TODO(unread): call from channelStore.select(id) so opening a channel marks
   * it read. Left uncalled for now so the stub stays inert.
   */
  markRead(channelId: number): void {
    if (_counts[channelId]) delete _counts[channelId];
  },

  /** Drop all unread state (logout / session-invalid teardown). */
  clear(): void {
    _counts = {};
  },
};
