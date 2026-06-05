<script lang="ts">
  import { store } from "./authStore.svelte";
  import { channelStore } from "./channelStore.svelte";
  import { gateway } from "./gateway.svelte";
  import { fetchMessages } from "./messages";

  // Mirrors the server default (server/src/config.ts MAX_MESSAGE_LENGTH). Not exposed over
  // any endpoint, so hard-coded here for the composer guard only — the server stays
  // authoritative and silently drops over-length message.send frames.
  const MAX_MESSAGE_LENGTH = 4000;
  const PAGE_SIZE = 50;

  type LoadStatus = "idle" | "loading" | "error";

  const activeChannel = $derived(
    gateway.channels.find((c) => c.id === channelStore.activeId) ?? null,
  );
  const messages = $derived(
    channelStore.activeId === null ? [] : gateway.messagesFor(channelStore.activeId),
  );
  const memberById = $derived(new Map(gateway.members.map((m) => [m.id, m])));

  function authorName(id: number): string {
    const m = memberById.get(id);
    return m?.displayName ?? m?.username ?? String(id);
  }

  let loadStatus = $state<LoadStatus>("idle");
  let loadErr = $state("");
  let hasMore = $state(false);
  let loadingOlder = $state(false);

  let draft = $state("");
  const canSend = $derived(
    activeChannel !== null &&
      draft.trim() !== "" &&
      draft.trim().length <= MAX_MESSAGE_LENGTH,
  );

  // Fetch the latest page whenever the active channel changes. Capture the id and re-check
  // before applying so a slow fetch for a deselected channel doesn't clobber the view.
  $effect(() => {
    const id = channelStore.activeId;
    if (id === null) return;

    loadStatus = "loading";
    loadErr = "";

    fetchMessages({
      serverUrl: store.serverUrl,
      token: store.sessionToken!,
      channelId: id,
      limit: PAGE_SIZE,
    }).then((result) => {
      if (channelStore.activeId !== id) return; // user switched mid-fetch
      if (result.ok) {
        gateway.prependHistory(id, [...result.data].reverse());
        hasMore = result.data.length === PAGE_SIZE;
        loadStatus = "idle";
      } else {
        loadStatus = "error";
        loadErr =
          result.error === "network"
            ? "Could not reach the server."
            : "Could not load messages.";
      }
    });
  });

  async function loadOlder(): Promise<void> {
    const id = channelStore.activeId;
    const before = messages[0]?.id;
    if (id === null || before === undefined || loadingOlder) return;

    loadingOlder = true;
    const result = await fetchMessages({
      serverUrl: store.serverUrl,
      token: store.sessionToken!,
      channelId: id,
      before,
      limit: PAGE_SIZE,
    });
    loadingOlder = false;

    if (channelStore.activeId !== id) return;
    if (result.ok) {
      gateway.prependHistory(id, [...result.data].reverse());
      hasMore = result.data.length === PAGE_SIZE;
    }
  }

  function submitSend(event: Event): void {
    event.preventDefault();
    if (!canSend || activeChannel === null) return;
    gateway.sendMessage(activeChannel.id, draft.trim());
    draft = ""; // clear immediately — the authoritative row renders on the broadcast
  }

  function formatTime(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
</script>

<section class="pane">
  {#if activeChannel === null}
    <p class="placeholder">Select a channel to start chatting.</p>
  {:else}
    <h2><span class="hash">#</span>{activeChannel.name}</h2>

    <div class="history">
      {#if hasMore}
        <button type="button" class="load-older" onclick={loadOlder} disabled={loadingOlder}>
          {loadingOlder ? "Loading…" : "Load older messages"}
        </button>
      {/if}

      {#if loadStatus === "loading" && messages.length === 0}
        <p class="hint">Loading messages…</p>
      {:else if loadStatus === "error"}
        <p class="err">{loadErr}</p>
      {:else if messages.length === 0}
        <p class="hint">No messages yet. Say something!</p>
      {/if}

      <ul class="messages">
        {#each messages as msg (msg.id)}
          <li class="message">
            <span class="author">{authorName(msg.authorId)}</span>
            <span class="time">{formatTime(msg.createdAt)}</span>
            <span class="content">{msg.content}</span>
          </li>
        {/each}
      </ul>
    </div>

    <form class="composer" onsubmit={submitSend}>
      <input
        bind:value={draft}
        placeholder={`Message #${activeChannel.name}`}
        aria-label="Message"
        maxlength={MAX_MESSAGE_LENGTH}
      />
      <button type="submit" disabled={!canSend}>Send</button>
    </form>
  {/if}
</section>

<style>
  .pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  h2 {
    margin: 0 0 0.75rem;
    font-size: 0.9rem;
    color: var(--text);
  }
  .hash {
    color: var(--muted);
    margin-right: 0.25rem;
  }
  .placeholder,
  .hint {
    color: var(--muted);
    font-size: 0.9rem;
  }
  .history {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  .messages {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .message {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    padding: 0.3rem 0;
  }
  .author {
    font-weight: 600;
    color: var(--text);
  }
  .time {
    font-size: 0.7rem;
    color: var(--muted);
  }
  .content {
    flex-basis: 100%;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text);
  }
  .load-older {
    width: 100%;
    background: none;
    color: var(--muted);
    margin-bottom: 0.5rem;
  }
  .load-older:hover {
    color: var(--text);
  }
  .composer {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .composer input {
    flex: 1;
  }
  .err {
    color: var(--err, #f87171);
    font-size: 0.85rem;
  }
</style>
