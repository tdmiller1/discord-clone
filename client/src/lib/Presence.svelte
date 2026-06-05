<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { store } from "./authStore.svelte";
  import { channelStore } from "./channelStore.svelte";
  import { createChannel, type ChannelErrorCode } from "./channels";
  import { gateway } from "./gateway.svelte";
  import MessagePane from "./MessagePane.svelte";

  let { onLogout, onSessionInvalid } = $props<{
    onLogout: () => void;
    onSessionInvalid: () => void;
  }>();

  type CreateStatus = "idle" | "submitting" | "error";

  let newName = $state("");
  let createStatus = $state<CreateStatus>("idle");
  let createErr = $state("");

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
      return;
    }

    createStatus = "error";
    createErr = createMessageFor(result.error);
  }

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

<main>
  <h1>discord-clone</h1>
  <p class="tagline">Signed in as {store.currentUser?.username ?? "user"}.</p>

  {#if statusLabel}
    <p class="status" class:connected={gateway.status === "open"}>{statusLabel}</p>
  {/if}

  <section class="card">
    <h2>Channels</h2>
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

    <form class="create" onsubmit={submitCreate}>
      <div class="row">
        <input bind:value={newName} placeholder="new-channel" aria-label="New channel name" />
        <button type="submit" disabled={!canCreate}>
          {createStatus === "submitting" ? "Creating…" : "Create"}
        </button>
      </div>
      {#if createStatus === "error"}
        <p class="err">{createErr}</p>
      {/if}
    </form>
  </section>

  <section class="card pane-card">
    <MessagePane />
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
        </li>
      {/each}
    </ul>
    <div class="row">
      <button onclick={onLogout}>Log out</button>
    </div>
  </section>
</main>

<style>
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
  .pane-card {
    display: flex;
    flex-direction: column;
    min-height: 16rem;
  }
  .create .row {
    gap: 0.5rem;
  }
  .err {
    color: var(--err, #f87171);
    font-size: 0.85rem;
    margin: 0.4rem 0 0;
  }
</style>
