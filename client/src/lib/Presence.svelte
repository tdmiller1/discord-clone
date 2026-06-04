<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { store } from "./authStore.svelte";
  import { gateway } from "./gateway.svelte";

  let { onLogout, onSessionInvalid } = $props<{
    onLogout: () => void;
    onSessionInvalid: () => void;
  }>();

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
</style>
