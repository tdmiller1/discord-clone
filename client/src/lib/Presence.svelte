<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { store } from "./authStore.svelte";
  import { channelStore } from "./channelStore.svelte";
  import { createChannel, normalizeChannelName, type ChannelErrorCode } from "./channels";
  import { gateway } from "./gateway.svelte";
  import Avatar from "./Avatar.svelte";
  import InviteFriend from "./InviteFriend.svelte";
  import MessagePane from "./MessagePane.svelte";
  import Profile from "./Profile.svelte";
  import { unreadStore } from "./unreadStore.svelte";
  import VoicePanel from "./VoicePanel.svelte";

  let { onLogout, onSessionInvalid } = $props<{
    onLogout: () => void;
    onSessionInvalid: () => void;
  }>();

  type CreateStatus = "idle" | "submitting" | "error";

  // Resizable left rail: users can widen it past the default, capped at RAIL_MAX.
  // The chosen width is persisted so the layout is remembered across sessions.
  const RAIL_MIN = 260;
  const RAIL_MAX = 500;
  const RAIL_STORAGE_KEY = "railWidth";
  let railWidth = $state(RAIL_MIN);
  let resizing = $state(false);

  const clampWidth = (w: number): number => Math.min(RAIL_MAX, Math.max(RAIL_MIN, w));

  function persistWidth(): void {
    try {
      localStorage.setItem(RAIL_STORAGE_KEY, String(railWidth));
    } catch {
      // Ignore storage failures (private mode / disabled) — width still applies this session.
    }
  }

  onMount(() => {
    const saved = Number(localStorage.getItem(RAIL_STORAGE_KEY));
    if (Number.isFinite(saved) && saved > 0) railWidth = clampWidth(saved);
  });

  // The rail starts at viewport x=0, so the pointer's clientX is the target width.
  function onResizeMove(event: PointerEvent): void {
    railWidth = clampWidth(event.clientX);
  }

  function endResize(): void {
    resizing = false;
    window.removeEventListener("pointermove", onResizeMove);
    window.removeEventListener("pointerup", endResize);
    persistWidth();
  }

  function startResize(event: PointerEvent): void {
    event.preventDefault();
    resizing = true;
    window.addEventListener("pointermove", onResizeMove);
    window.addEventListener("pointerup", endResize);
  }

  // Keyboard support for the separator: arrows nudge by 16px.
  function onResizeKey(event: KeyboardEvent): void {
    if (event.key === "ArrowLeft") railWidth = clampWidth(railWidth - 16);
    else if (event.key === "ArrowRight") railWidth = clampWidth(railWidth + 16);
    else return;
    event.preventDefault();
    persistWidth();
  }

  // --- Responsive layout ---------------------------------------------------
  // On narrow screens (phones) the three-column desktop layout collapses to a
  // single full-height chat column; the rails (voice, channels, profile,
  // members, invite) move into a slide-in drawer toggled from the top bar.
  // MOBILE_BREAKPOINT matches the CSS `.mobile` rules below.
  const MOBILE_BREAKPOINT = 900;
  let viewportWidth = $state(typeof window === "undefined" ? 1200 : window.innerWidth);
  const isMobile = $derived(viewportWidth <= MOBILE_BREAKPOINT);
  let drawerOpen = $state(false);

  function onViewportResize(): void {
    viewportWidth = window.innerWidth;
  }
  onMount(() => window.addEventListener("resize", onViewportResize));
  onDestroy(() => window.removeEventListener("resize", onViewportResize));

  // Active channel — used for the mobile top-bar title.
  const activeChannel = $derived(
    gateway.channels.find((c) => c.id === channelStore.activeId) ?? null,
  );

  // Selecting a channel from the drawer reveals the chat it opened.
  function selectChannel(id: number): void {
    channelStore.select(id);
    drawerOpen = false;
  }

  let newName = $state("");
  let createStatus = $state<CreateStatus>("idle");
  let createErr = $state("");
  let showCreate = $state(false);
  let createInput = $state<HTMLInputElement | null>(null);

  const canCreate = $derived(createStatus !== "submitting" && newName.trim() !== "");

  // Select a sensible default (first text channel) once channels arrive and none is active.
  $effect(() => {
    if (channelStore.activeId === null && gateway.channels.length > 0) {
      channelStore.select(gateway.channels[0].id);
    }
  });

  function createMessageFor(code: ChannelErrorCode): string {
    switch (code) {
      case "channel_name_invalid":
      case "bad_request":
        return "Enter a valid channel name (1–64 characters).";
      case "unauthorized":
        return "Your session has expired. Please log in again.";
      case "network":
        return "Could not reach the server.";
      default:
        return "Something went wrong. Please try again.";
    }
  }

  async function submitCreate(event: Event): Promise<void> {
    event.preventDefault();
    if (!canCreate) return;

    createStatus = "submitting";
    createErr = "";

    const result = await createChannel({
      serverUrl: store.serverUrl,
      token: store.sessionToken!,
      name: normalizeChannelName(newName),
    });

    if (result.ok) {
      // The channel also arrives via `channel.create` (deduped by id); select it now.
      channelStore.select(result.data.id);
      newName = "";
      createStatus = "idle";
      showCreate = false;
      return;
    }

    createStatus = "error";
    createErr = createMessageFor(result.error);
  }

  function openCreate(): void {
    newName = "";
    createStatus = "idle";
    createErr = "";
    showCreate = true;
  }

  function closeCreate(): void {
    showCreate = false;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (showCreate) closeCreate();
    else if (drawerOpen) drawerOpen = false;
  }

  // Focus the name field as soon as the modal mounts.
  $effect(() => {
    if (showCreate && createInput) createInput.focus();
  });

  // Own the socket lifecycle: connect when this view mounts, tear down when it unmounts.
  onMount(() => gateway.connect());
  onDestroy(() => {
    gateway.disconnect();
    window.removeEventListener("pointermove", onResizeMove);
    window.removeEventListener("pointerup", endResize);
  });

  // A 4001 close means the stored session is dead — let App clear it + return to login.
  $effect(() => {
    if (gateway.authFailed) onSessionInvalid();
  });

  const selfId = $derived(store.currentUser?.id ?? null);

  const statusLabel = $derived(
    gateway.status === "connecting"
      ? "Connecting…"
      : gateway.status === "reconnecting"
        ? "Reconnecting…"
        : gateway.status === "open"
          ? "Connected"
          : "",
  );
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="app-shell"
  class:resizing
  class:mobile={isMobile}
  class:drawer-open={drawerOpen}
  style="--rail-w: {railWidth}px"
>
  <!-- Mobile only: top bar with a hamburger toggle and the active channel name.
       The hamburger opens/closes the full-view drawer holding the rails. -->
  {#if isMobile}
    <header class="mobile-bar">
      <button
        type="button"
        class="menu-btn"
        aria-label={drawerOpen ? "Close menu" : "Open menu"}
        aria-expanded={drawerOpen}
        onclick={() => (drawerOpen = !drawerOpen)}
      >
        {drawerOpen ? "✕" : "☰"}
      </button>
      <span class="mobile-title">
        {#if activeChannel}<span class="hash">#</span>{activeChannel.name}{:else}discord-clone{/if}
      </span>
    </header>
  {/if}

  <!-- Both rails live inside this drawer. On desktop `display: contents` dissolves
       the wrapper so the rails sit directly in their grid columns; on mobile it
       becomes a slide-in panel covering the chat. -->
  <div class="drawer">
  <!-- Left rail: Voice on top, Channels below, with the signed-in line pinned to the
       bottom (just above the fixed version badge). -->
  <nav class="rail">
    {#if gateway.voiceChannels.length > 0}
      <section class="card">
        <VoicePanel />
      </section>
    {/if}

    <section class="card">
      <div class="card-head">
        <h2>Channels</h2>
        <button
          type="button"
          class="add-channel"
          onclick={openCreate}
          aria-label="Create channel"
          title="Create channel"
        >
          +
        </button>
      </div>
      <ul class="channels">
        {#each gateway.channels as c (c.id)}
          {@const unread = unreadStore.count(c.id)}
          <li>
            <button
              type="button"
              class="channel"
              class:active={c.id === channelStore.activeId}
              class:unread={unread > 0}
              onclick={() => selectChannel(c.id)}
            >
              <span class="hash">#</span><span class="cname">{c.name}</span>
              {#if unread > 0}
                <span class="unread-badge" title="{unread} unread">{unread > 99 ? "99+" : unread}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </section>

    <div class="rail-footer">
      <section class="card profile-card">
        <Profile {onLogout} connected={gateway.status === "open"} status={statusLabel} />
      </section>
    </div>
  </nav>

  <!-- Right rail: members. -->
  <aside class="members-rail">
    <section class="card">
      <h2>Members</h2>
      <ul class="members">
        {#each gateway.members as m (m.id)}
          <li class="member">
            <span class="member-av" class:offline-av={m.status === "offline"}>
              <Avatar avatarId={m.avatarId} name={m.username} size={28} />
              <span
                class="dot"
                class:online={m.status === "online"}
                class:offline={m.status === "offline"}
              ></span>
            </span>
            <span class="name" class:offline-name={m.status === "offline"}>
              {m.username}{m.id === selfId ? " (you)" : ""}
            </span>
            {#if m.voiceChannelId !== null}
              <span class="voice-marker" title="In voice">🔊</span>
            {/if}
          </li>
        {/each}
      </ul>
    </section>

    <div class="rail-footer">
      <section class="card">
        <InviteFriend />
      </section>
    </div>
  </aside>
  </div>

  <!-- Drag handle on the rail's right edge: widen the left rail up to 500px.
       A focusable role="separator" is the correct splitter pattern; the a11y
       lints below don't recognize it as interactive, so they're suppressed.
       Hidden on mobile (the drawer has no draggable boundary). -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="rail-resizer"
    class:active={resizing}
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize sidebar"
    aria-valuemin={RAIL_MIN}
    aria-valuemax={RAIL_MAX}
    aria-valuenow={railWidth}
    tabindex="0"
    onpointerdown={startResize}
    onkeydown={onResizeKey}
  ></div>

  <!-- Center: the channel viewer fills the remaining horizontal space and full height. -->
  <main class="content">
    <section class="card pane-card">
      <MessagePane />
    </section>
  </main>
</div>

<!-- Create-channel modal: lifts the form out of the cramped rail into a centered
     dialog over the app. -->
{#if showCreate}
  <div class="modal-layer">
    <button type="button" class="modal-backdrop" aria-label="Close" onclick={closeCreate}></button>
    <div class="modal" role="dialog" aria-modal="true" aria-label="Create channel">
      <h2 class="modal-title">Create channel</h2>
      <form class="create" onsubmit={submitCreate}>
        <input
          bind:this={createInput}
          bind:value={newName}
          oninput={() => (newName = newName.replace(/\s+/g, "-"))}
          placeholder="new-channel"
          aria-label="New channel name"
        />
        {#if createStatus === "error"}
          <p class="err">{createErr}</p>
        {/if}
        <div class="modal-actions">
          <button type="button" class="cancel" onclick={closeCreate}>Cancel</button>
          <button type="submit" disabled={!canCreate}>
            {createStatus === "submitting" ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  /* Full-width, full-height app shell: fixed left + right rails flanking a fluid
     center column that holds the channel viewer. */
  .app-shell {
    position: relative;
    display: grid;
    grid-template-columns: var(--rail-w, 260px) minmax(0, 1fr) 248px;
    height: 100vh;
    width: 100%;
  }
  /* While dragging, kill text selection and force the resize cursor everywhere. */
  .app-shell.resizing {
    user-select: none;
    cursor: col-resize;
  }

  /* Vertical drag handle straddling the rail/content boundary (at --rail-w). */
  .rail-resizer {
    position: absolute;
    top: 0;
    left: var(--rail-w, 260px);
    width: 6px;
    height: 100%;
    margin-left: -3px;
    z-index: 5;
    cursor: col-resize;
    background: transparent;
    transition: background 0.12s ease;
  }
  .rail-resizer:hover,
  .rail-resizer:focus-visible,
  .rail-resizer.active {
    background: var(--accent);
    outline: none;
  }

  /* Cards inside the shell drop the global top margin — the rails space them with
     flex gap instead. */
  .app-shell .card {
    margin-top: 0;
  }

  /* Left rail: voice + channels stack at the top; the footer (status + signed-in)
     is pushed to the bottom. */
  .rail {
    grid-column: 1;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
    min-height: 0;
    overflow-y: auto;
  }
  .rail-footer {
    margin-top: auto;
    /* Sit just above the fixed version badge (App.svelte, bottom: 6px). */
    padding-bottom: 1.25rem;
  }
  .profile-card {
    margin-bottom: 0.5rem;
  }

  /* Center: the channel viewer fills the remaining width and full height. Overrides
     the global centered-column `main` rule. */
  .content {
    grid-column: 2;
    max-width: none;
    margin: 0;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .pane-card {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* Right rail: profile + members. */
  .members-rail {
    grid-column: 3;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
    min-height: 0;
    overflow-y: auto;
  }

  /* On desktop the drawer wrapper dissolves so the two rails sit directly in
     their grid columns (grid-column is set on each rail explicitly). */
  .drawer {
    display: contents;
  }

  /* The mobile top bar is desktop-hidden; shown only via the `.mobile` class. */
  .mobile-bar {
    display: none;
  }

  /* ---- Narrow screens: single chat column + slide-in drawer ------------- */
  .app-shell.mobile {
    display: flex;
    flex-direction: column;
    /* dvh tracks the mobile browser's shrinking viewport (URL bar) where supported. */
    height: 100vh;
    height: 100dvh;
  }

  .app-shell.mobile .mobile-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: none;
    padding: 0.5rem 0.75rem;
    background: var(--surface);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    /* Above the drawer so the close (✕) button stays reachable. */
    z-index: 30;
  }
  .menu-btn {
    flex: none;
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.2rem;
    line-height: 1;
    background: none;
    color: var(--text);
    border-radius: 0.4rem;
  }
  .menu-btn:hover {
    background: var(--accent);
  }
  .mobile-title {
    min-width: 0;
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mobile-title .hash {
    color: var(--muted);
    margin-right: 0.15rem;
  }

  /* Chat fills the rest of the screen below the bar. */
  .app-shell.mobile .content {
    flex: 1;
    min-height: 0;
    padding: 0.75rem;
  }

  /* No draggable rail boundary on mobile. */
  .app-shell.mobile .rail-resizer {
    display: none;
  }

  /* The drawer becomes a full-view slide-in panel holding both rails stacked. */
  .app-shell.mobile .drawer {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    /* Clear the top bar (which sits above on z-index). */
    padding: 3.5rem 1rem 1rem;
    background: var(--bg);
    overflow-y: auto;
    z-index: 20;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  .app-shell.mobile.drawer-open .drawer {
    transform: translateX(0);
  }
  /* Inside the drawer the rails are plain stacked blocks, not grid tracks.
     flex: none keeps them at their content height so the drawer scrolls instead
     of the flex column squeezing them until their contents overlap. */
  .app-shell.mobile .rail,
  .app-shell.mobile .members-rail {
    flex: none;
    overflow: visible;
    padding: 0;
  }
  /* The left rail's footer normally pushes the profile to the bottom of a full-
     height column; in the stacked drawer that gap is dead space, so collapse it. */
  .app-shell.mobile .rail-footer {
    margin-top: 0;
    padding-bottom: 0;
  }

  h2 {
    margin: 0 0 0.75rem;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .members {
    list-style: none;
    margin: 0 0 1rem;
    padding: 0;
  }
  .member {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.4rem 0;
  }
  /* Avatar + a status dot badged on its bottom-right corner. */
  .member-av {
    position: relative;
    flex: none;
    line-height: 0;
  }
  .offline-av {
    opacity: 0.55;
  }
  .dot {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    /* Ring in the rail background so the dot reads as a badge over the avatar. */
    box-shadow: 0 0 0 2px var(--surface);
  }
  .dot.online {
    background: var(--ok);
  }
  .dot.offline {
    background: var(--muted);
  }
  .offline-name {
    color: var(--muted);
  }
  .voice-marker {
    font-size: 0.8rem;
    color: var(--ok);
  }
  .channels {
    list-style: none;
    margin: 0 0 0.75rem;
    padding: 0;
  }
  .channels li {
    margin: 0.15rem 0;
  }
  .channel {
    width: 100%;
    display: flex;
    align-items: center;
    text-align: left;
    background: none;
    color: var(--muted);
    padding: 0.35rem 0.5rem;
    border-radius: 0.35rem;
    font-weight: 500;
  }
  .channel:hover {
    color: var(--text);
  }
  .channel.active {
    background: var(--accent);
    color: var(--text);
  }
  .cname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Unread channels read brighter + bolder, mirroring Discord's "white channel name". */
  .channel.unread {
    color: var(--text);
    font-weight: 600;
  }
  .hash {
    color: var(--muted);
    margin-right: 0.25rem;
  }
  .channel.active .hash,
  .channel.unread .hash {
    color: var(--text);
  }
  /* Count pill pinned to the right edge of the channel row. */
  .unread-badge {
    flex: none;
    margin-left: 0.4rem;
    min-width: 1.1rem;
    padding: 0 0.35rem;
    height: 1.1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--err, #f23f43);
    color: #fff;
    font-size: 0.7rem;
    font-weight: 700;
    line-height: 1;
    border-radius: 0.55rem;
  }
  .err {
    color: var(--err, #f87171);
    font-size: 0.85rem;
    margin: 0.4rem 0 0;
  }

  /* Channels header: title on the left, a compact add (+) button on the right. */
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }
  .card-head h2 {
    margin: 0;
  }
  .add-channel {
    flex: none;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.1rem;
    line-height: 1;
    background: none;
    color: var(--muted);
    border-radius: 0.35rem;
  }
  .add-channel:hover {
    background: var(--accent);
    color: var(--text);
  }

  /* Create-channel modal. The backdrop is a full-screen button so dismiss-on-click
     stays keyboard-accessible without static-element click handlers. */
  .modal-layer {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  .modal-backdrop {
    position: absolute;
    inset: 0;
    margin: 0;
    padding: 0;
    border: none;
    border-radius: 0;
    background: rgba(0, 0, 0, 0.6);
    cursor: default;
  }
  .modal {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 420px;
    padding: 1.5rem;
    background: var(--surface);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  }
  .modal-title {
    margin: 0 0 1rem;
    font-size: 1rem;
    text-transform: none;
    letter-spacing: normal;
    color: var(--text);
  }
  .modal .create input {
    width: 100%;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  .modal .cancel {
    background: none;
    color: var(--muted);
  }
  .modal .cancel:hover {
    color: var(--text);
  }
</style>
