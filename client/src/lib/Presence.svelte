<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { store } from "./authStore.svelte";
  import { channelStore } from "./channelStore.svelte";
  import { createChannel, type ChannelErrorCode } from "./channels";
  import { gateway } from "./gateway.svelte";
  import InviteFriend from "./InviteFriend.svelte";
  import MessagePane from "./MessagePane.svelte";
  import Profile from "./Profile.svelte";
  import VoicePanel from "./VoicePanel.svelte";

  let { onLogout, onSessionInvalid } = $props<{
    onLogout: () => void;
    onSessionInvalid: () => void;
  }>();

  type CreateStatus = "idle" | "submitting" | "error";

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
      name: newName.trim(),
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
    if (event.key === "Escape" && showCreate) closeCreate();
  }

  // Focus the name field as soon as the modal mounts.
  $effect(() => {
    if (showCreate && createInput) createInput.focus();
  });

  // Own the socket lifecycle: connect when this view mounts, tear down when it unmounts.
  onMount(() => gateway.connect());
  onDestroy(() => gateway.disconnect());

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

<div class="app-shell">
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
          <li>
            <button
              type="button"
              class="channel"
              class:active={c.id === channelStore.activeId}
              onclick={() => channelStore.select(c.id)}
            >
              <span class="hash">#</span>{c.name}
            </button>
          </li>
        {/each}
      </ul>
    </section>

    <div class="rail-footer">
      {#if statusLabel}
        <p class="status" class:connected={gateway.status === "open"}>{statusLabel}</p>
      {/if}
      <p class="signed-in">Signed in as {store.currentUser?.username ?? "user"}.</p>
    </div>
  </nav>

  <!-- Center: the channel viewer fills the remaining horizontal space and full height. -->
  <main class="content">
    <section class="card pane-card">
      <MessagePane />
    </section>
  </main>

  <!-- Right rail: your profile (change username) + members. -->
  <aside class="members-rail">
    <section class="card">
      <Profile />
    </section>

    <section class="card">
      <h2>Members</h2>
      <ul class="members">
        {#each gateway.members as m (m.id)}
          <li class="member">
            <span class="dot" class:online={m.status === "online"} class:offline={m.status === "offline"}
            ></span>
            <span class="name" class:offline-name={m.status === "offline"}>
              {m.username}{m.id === selfId ? " (you)" : ""}
            </span>
            {#if m.voiceChannelId !== null}
              <span class="voice-marker" title="In voice">🔊</span>
            {/if}
          </li>
        {/each}
      </ul>
      <InviteFriend />
      <div class="row">
        <button onclick={onLogout}>Log out</button>
      </div>
    </section>
  </aside>
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
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr) 248px;
    height: 100vh;
    width: 100%;
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
  .signed-in {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0.25rem 0 0;
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

  /* Too narrow for three columns: stack into one scrolling page. */
  @media (max-width: 900px) {
    .app-shell {
      display: block;
      height: auto;
    }
    .rail,
    .members-rail {
      overflow: visible;
    }
    .pane-card {
      min-height: 24rem;
    }
  }

  .status {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0.5rem 0 0;
  }
  .status.connected {
    color: var(--ok);
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
  .dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    flex: none;
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
  .hash {
    color: var(--muted);
    margin-right: 0.25rem;
  }
  .channel.active .hash {
    color: var(--text);
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
