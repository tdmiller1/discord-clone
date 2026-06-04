/**
 * Reactive active-channel selection store (Svelte 5 runes). Lives in a *.svelte.ts
 * module so $state works outside a component, mirroring authStore.svelte.ts. Holds
 * only the selected channel id (the stable identity); consumers resolve the channel
 * object from gateway.channels.
 *
 * This is the contracts/client-channel-state.md deliverable consumed by story 005's
 * message pane, which reads channelStore.activeId to fetch/render history. Kept
 * separate from the gateway so consumers import selection without pulling in WS
 * internals (mirrors the authStore / gateway split).
 */

let _activeId = $state<number | null>(null);

/** The reactive active-channel singleton. Read activeId directly off it. */
export const channelStore = {
  /** The id of the currently selected channel, or null when none is selected. */
  get activeId(): number | null {
    return _activeId;
  },

  /** Mark a channel active (called on user selection or default-selection). */
  select(id: number): void {
    _activeId = id;
  },

  /** Reset the selection (logout / session-invalid teardown). */
  clear(): void {
    _activeId = null;
  },
};
