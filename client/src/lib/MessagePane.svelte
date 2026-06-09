<script lang="ts">
  import { tick } from "svelte";
  import { store } from "./authStore.svelte";
  import { channelStore } from "./channelStore.svelte";
  import { gateway } from "./gateway.svelte";
  import { fetchMessages } from "./messages";
  import { uploadAttachment } from "./attachments";
  import type { AttachmentErrorCode } from "./attachments";
  import type { PublicMessage } from "./types";
  import Avatar from "./Avatar.svelte";
  import InlineImage from "./InlineImage.svelte";

  // Mirrors the server default (server/src/config.ts MAX_MESSAGE_LENGTH). Not exposed over
  // any endpoint, so hard-coded here for the composer guard only — the server stays
  // authoritative and silently drops over-length message.send frames.
  const MAX_MESSAGE_LENGTH = 4000;
  const PAGE_SIZE = 50;

  // Mirrors the server MAX_UPLOAD_MB / allowed image types. Not exposed over any endpoint,
  // so hard-coded here as fail-fast UX only — the server re-sniffs bytes and re-checks size
  // and stays authoritative, rejecting anything that slips past this guard.
  const MAX_UPLOAD_MB = 10;
  const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
  const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

  type LoadStatus = "idle" | "loading" | "error";

  const activeChannel = $derived(
    gateway.channels.find((c) => c.id === channelStore.activeId) ?? null,
  );
  const messages = $derived(
    channelStore.activeId === null ? [] : gateway.messagesFor(channelStore.activeId),
  );
  const memberById = $derived(new Map(gateway.members.map((m) => [m.id, m])));
  // The logged-in user's id — only their own messages expose the edit affordance.
  const currentUserId = $derived(store.currentUser?.id ?? null);

  function authorName(id: number): string {
    const m = memberById.get(id);
    return m?.displayName ?? m?.username ?? String(id);
  }

  // Avatar id for an author (null when unknown / never set → Avatar shows the initial fallback).
  function authorAvatarId(id: number): number | null {
    return memberById.get(id)?.avatarId ?? null;
  }

  let loadStatus = $state<LoadStatus>("idle");
  let loadErr = $state("");
  let hasMore = $state(false);
  let loadingOlder = $state(false);

  // Auto-scroll: keep the view pinned to the newest message. `pinned` stays true
  // while the user is at (or near) the bottom; scrolling up to read history or
  // load older messages unpins so incoming messages don't yank the view down.
  let historyEl = $state<HTMLDivElement | null>(null);
  let messagesEl = $state<HTMLUListElement | null>(null);
  let pinned = $state(true);
  const PIN_THRESHOLD = 80; // px from the bottom still counts as "at the bottom"

  function scrollToBottom(): void {
    if (historyEl) historyEl.scrollTop = historyEl.scrollHeight;
  }

  function onHistoryScroll(): void {
    if (!historyEl) return;
    const distance = historyEl.scrollHeight - historyEl.scrollTop - historyEl.clientHeight;
    pinned = distance < PIN_THRESHOLD;
  }

  // Switching channels re-pins to the latest message of the new channel.
  $effect(() => {
    channelStore.activeId;
    pinned = true;
  });

  // After messages render (channel switch or a new arrival), stick to the bottom
  // while pinned. Track `activeId` too so switching between two channels that
  // happen to have the same message count still re-fires (length alone wouldn't
  // change). `loadingOlder` guards the prepend path, which must not scroll.
  $effect(() => {
    channelStore.activeId;
    void messages.length;
    if (!pinned || loadingOlder) return;
    void tick().then(scrollToBottom);
  });

  // Inline images decode AFTER the scroll above runs, growing the list and
  // stranding the view above the newest message. A ResizeObserver re-pins to the
  // bottom on any late size change (image load, font swap) while still pinned.
  $effect(() => {
    if (!messagesEl) return;
    const observer = new ResizeObserver(() => {
      if (pinned && !loadingOlder) scrollToBottom();
    });
    observer.observe(messagesEl);
    return () => observer.disconnect();
  });

  // The message currently being edited inline (id), and its working text. `null` = not editing.
  let editingId = $state<number | null>(null);
  let editDraft = $state("");

  let draft = $state("");
  let pendingFile = $state<File | null>(null);
  let previewUrl = $state<string | null>(null);
  let uploading = $state(false);
  let uploadErr = $state("");
  let fileInput: HTMLInputElement;

  const canSend = $derived(
    activeChannel !== null &&
      !uploading &&
      (pendingFile !== null || draft.trim() !== "") &&
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

  function onPickFile(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // reset so re-picking the same file refires onchange
    if (!file) return;

    if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
      uploadErr = "Only PNG, JPEG, GIF, or WebP images.";
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      uploadErr = `Image is larger than ${MAX_UPLOAD_MB} MB.`;
      return;
    }

    uploadErr = "";
    if (previewUrl !== null) URL.revokeObjectURL(previewUrl);
    pendingFile = file;
    previewUrl = URL.createObjectURL(file);
  }

  function clearPending(): void {
    if (previewUrl !== null) URL.revokeObjectURL(previewUrl);
    pendingFile = null;
    previewUrl = null;
    if (fileInput) fileInput.value = "";
  }

  function uploadErrorMessage(code: AttachmentErrorCode): string {
    switch (code) {
      case "unauthorized":
        return "Your session expired. Please sign in again.";
      case "file_too_large":
        return `Image is larger than ${MAX_UPLOAD_MB} MB.`;
      case "network":
        return "Could not reach the server.";
      case "invalid_image":
      case "no_file":
      case "not_multipart":
      case "bad_request":
      case "unknown":
      default:
        return "That image couldn't be uploaded.";
    }
  }

  async function submitSend(event: Event): Promise<void> {
    event.preventDefault();
    if (!canSend || activeChannel === null) return;
    uploadErr = "";

    if (pendingFile === null) {
      gateway.sendMessage(activeChannel.id, draft.trim());
      draft = ""; // clear immediately — the authoritative row renders on the broadcast
      return;
    }

    // Capture the target channel before awaiting so a slow upload that resolves after a
    // channel switch still sends to the originally-targeted channel.
    const channelId = activeChannel.id;
    uploading = true;
    const result = await uploadAttachment({
      serverUrl: store.serverUrl,
      token: store.sessionToken!,
      file: pendingFile,
    });
    uploading = false;

    if (result.ok) {
      gateway.sendMessage(channelId, draft.trim(), result.data.id);
      draft = "";
      clearPending();
    } else {
      // Keep the typed text and the pending image so the user can retry.
      uploadErr = uploadErrorMessage(result.error);
    }
  }

  function formatTime(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function startEdit(msg: PublicMessage): void {
    editingId = msg.id;
    editDraft = msg.content;
  }

  function cancelEdit(): void {
    editingId = null;
    editDraft = "";
  }

  // Commit the edit over the WS. The authoritative row (with editedAt set) arrives on the
  // message.update broadcast, so we just close the editor — no optimistic mutation.
  function saveEdit(msg: PublicMessage): void {
    const trimmed = editDraft.trim();
    // Unchanged → nothing to send; just close. Blank text on a text-only message is
    // rejected by the server (and pointless), so keep the editor open instead.
    if (trimmed === msg.content) {
      cancelEdit();
      return;
    }
    if (trimmed === "" && msg.attachment === null) return;
    gateway.editMessage(msg.id, trimmed);
    cancelEdit();
  }

  function onEditKeydown(event: KeyboardEvent, msg: PublicMessage): void {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    } else if (event.key === "Enter" && !event.shiftKey) {
      // Enter saves; Shift+Enter inserts a newline (the textarea's default).
      event.preventDefault();
      saveEdit(msg);
    }
  }

  // Focus + place the caret at the end when an edit textarea mounts.
  function autofocusEnd(node: HTMLTextAreaElement) {
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }
</script>

<section class="pane">
  {#if activeChannel === null}
    <p class="placeholder">Select a channel to start chatting.</p>
  {:else}
    <h2><span class="hash">#</span>{activeChannel.name}</h2>

    <div class="history" bind:this={historyEl} onscroll={onHistoryScroll}>
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

      <ul class="messages" bind:this={messagesEl}>
        {#each messages as msg, i (msg.id)}
          {@const grouped = i > 0 && messages[i - 1].authorId === msg.authorId}
          <li class="message" class:grouped>
            <div class="gutter">
              {#if grouped}
                <span class="hover-time">{formatTime(msg.createdAt)}</span>
              {:else}
                <Avatar avatarId={authorAvatarId(msg.authorId)} name={authorName(msg.authorId)} size={36} />
              {/if}
            </div>
            <div class="body">
              {#if !grouped}
                <div class="meta">
                  <span class="author">{authorName(msg.authorId)}</span>
                  <span class="time">{formatTime(msg.createdAt)}</span>
                </div>
              {/if}
              {#if editingId === msg.id}
                <div class="edit">
                  <textarea
                    class="edit-input"
                    bind:value={editDraft}
                    maxlength={MAX_MESSAGE_LENGTH}
                    onkeydown={(e) => onEditKeydown(e, msg)}
                    use:autofocusEnd
                  ></textarea>
                  <div class="edit-hint">
                    escape to <button type="button" class="link" onclick={cancelEdit}>cancel</button>
                    • enter to <button type="button" class="link" onclick={() => saveEdit(msg)}>save</button>
                  </div>
                </div>
              {:else}
                {#if msg.content.trim() !== ""}
                  <span class="content"
                    >{msg.content}{#if msg.editedAt !== null}<span
                        class="edited"
                        title={`edited ${new Date(msg.editedAt).toLocaleString()}`}>(edited)</span
                      >{/if}</span
                  >
                {/if}
                {#if msg.attachment !== null}
                  <div class="attachment"><InlineImage attachment={msg.attachment} /></div>
                {/if}
              {/if}
            </div>
            {#if msg.authorId === currentUserId && editingId !== msg.id}
              <div class="actions">
                <button
                  type="button"
                  class="action"
                  aria-label="Edit message"
                  title="Edit"
                  onclick={() => startEdit(msg)}
                >
                  Edit
                </button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </div>

    {#if pendingFile}
      <div class="pending">
        <img class="thumb" src={previewUrl} alt={pendingFile.name} />
        <span class="filename">{pendingFile.name}</span>
        <button type="button" class="remove" onclick={clearPending} disabled={uploading}>
          Remove
        </button>
      </div>
    {/if}
    {#if uploading}
      <p class="hint">Uploading…</p>
    {/if}
    {#if uploadErr}
      <p class="err">{uploadErr}</p>
    {/if}

    <form class="composer" onsubmit={submitSend}>
      <input
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        bind:this={fileInput}
        onchange={onPickFile}
        hidden
      />
      <button
        type="button"
        class="attach"
        onclick={() => fileInput.click()}
        disabled={uploading}
        aria-label="Attach image"
        title="Attach image"
      >
        +
      </button>
      <input
        bind:value={draft}
        placeholder={`Message #${activeChannel.name}`}
        aria-label="Message"
        maxlength={MAX_MESSAGE_LENGTH}
        disabled={uploading}
      />
      <button type="submit" disabled={!canSend}>Send</button>
    </form>
  {/if}
</section>

<style>
  .pane {
    display: flex;
    flex-direction: column;
    flex: 1;
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
  /* Discord-style row: fixed avatar gutter on the left, message body on the right.
     Consecutive messages from the same author are "grouped" — they drop the avatar
     and name, tightening the spacing and showing the timestamp only on hover. */
  .message {
    display: flex;
    gap: 0.6rem;
    padding: 0.1rem 0;
    position: relative;
  }
  /* Subtle row highlight on hover, like Discord, anchoring the floating actions. */
  .message:hover {
    background: var(--hover, rgba(255, 255, 255, 0.03));
  }
  .message:not(.grouped) {
    margin-top: 0.6rem;
  }
  .gutter {
    flex: none;
    width: 36px;
    display: flex;
    justify-content: center;
  }
  /* Timestamp shown in the gutter on hover for grouped messages (hidden otherwise). */
  .hover-time {
    font-size: 0.62rem;
    color: var(--muted);
    line-height: 1.4;
    opacity: 0;
  }
  .message.grouped:hover .hover-time {
    opacity: 1;
  }
  .body {
    flex: 1;
    min-width: 0;
  }
  .meta {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
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
    display: block;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text);
  }
  /* Inline "(edited)" marker trailing the content (Discord-style). */
  .edited {
    margin-left: 0.35rem;
    font-size: 0.62rem;
    color: var(--muted);
    user-select: none;
  }
  .attachment {
    margin-top: 0.15rem;
  }
  /* Floating per-message action toolbar, revealed on row hover (own messages only). */
  .actions {
    position: absolute;
    top: -0.6rem;
    right: 0.25rem;
    display: none;
    background: var(--surface, #1e1f22);
    border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    border-radius: 4px;
  }
  .message:hover .actions {
    display: flex;
  }
  .action {
    background: none;
    color: var(--muted);
    font-size: 0.72rem;
    padding: 0.15rem 0.4rem;
  }
  .action:hover {
    color: var(--text);
  }
  /* Inline edit textarea + keyboard hint. */
  .edit {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .edit-input {
    width: 100%;
    min-height: 2.2rem;
    resize: vertical;
    font: inherit;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .edit-hint {
    font-size: 0.7rem;
    color: var(--muted);
  }
  .edit-hint .link {
    background: none;
    padding: 0;
    color: var(--accent, #5865f2);
    font-size: inherit;
  }
  .edit-hint .link:hover {
    text-decoration: underline;
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
  .composer .attach {
    flex: 0 0 auto;
    width: 2rem;
    /* Square icon button: zero the global button padding (which on a 2rem-wide
       border-box button would shove the glyph off-center) and flex-center the +. */
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.25rem;
    line-height: 1;
  }
  .pending {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .thumb {
    max-height: 3rem;
    max-width: 3rem;
    border-radius: 4px;
    object-fit: cover;
  }
  .filename {
    flex: 1;
    font-size: 0.85rem;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remove {
    flex: 0 0 auto;
    background: none;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .remove:hover {
    color: var(--text);
  }
  .err {
    color: var(--err, #f87171);
    font-size: 0.85rem;
  }
</style>
