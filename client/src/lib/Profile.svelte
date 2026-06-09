<script lang="ts">
  import { store } from "./authStore.svelte";
  import { updateUsername, type AuthErrorCode } from "./auth";

  // idle: show the current name + Edit. editing: name field + Save/Cancel. saving: in-flight.
  type Status = "idle" | "editing" | "saving";

  let status = $state<Status>("idle");
  let draft = $state("");
  let err = $state("");
  let saved = $state(false);

  const current = $derived(store.currentUser?.username ?? "");
  const trimmed = $derived(draft.trim());
  // Mirror the server rule (1–64 chars) and skip no-op saves; the server stays authoritative.
  const canSave = $derived(
    status === "editing" && trimmed !== "" && trimmed !== current && trimmed.length <= 64,
  );

  function startEdit(): void {
    draft = current;
    err = "";
    saved = false;
    status = "editing";
  }

  function cancel(): void {
    status = "idle";
    err = "";
  }

  function messageFor(code: AuthErrorCode): string {
    switch (code) {
      case "username_taken":
        return "That username is already taken.";
      case "bad_request":
        return "Enter a valid username (1–64 characters).";
      case "rate_limited":
        return "Too many changes — try again in a moment.";
      case "unauthorized":
        return "Your session has expired. Please log in again.";
      case "network":
        return "Could not reach the server.";
      default:
        return "Could not change your username.";
    }
  }

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    if (!canSave) return;

    status = "saving";
    err = "";
    const result = await updateUsername({
      serverUrl: store.serverUrl,
      token: store.sessionToken!,
      username: trimmed,
    });

    if (result.ok) {
      // Update our own identity from the response; every other client (and our own
      // member-list entry) updates via the server's `user.update` broadcast.
      store.setUser(result.user);
      status = "idle";
      saved = true;
    } else {
      status = "editing";
      err = messageFor(result.error);
    }
  }
</script>

<div class="profile">
  <h2>Your profile</h2>

  {#if status === "idle"}
    <div class="current">
      <span class="username" title={current}>{current}</span>
      <button type="button" class="edit" onclick={startEdit}>Edit</button>
    </div>
    {#if saved}<p class="ok">Username updated.</p>{/if}
  {:else}
    <form onsubmit={submit}>
      <div class="row">
        <input
          bind:value={draft}
          aria-label="New username"
          maxlength={64}
          disabled={status === "saving"}
        />
        <button type="submit" disabled={!canSave}>
          {status === "saving" ? "Saving…" : "Save"}
        </button>
      </div>
      <button type="button" class="link" onclick={cancel} disabled={status === "saving"}>
        Cancel
      </button>
      {#if err}<p class="err">{err}</p>{/if}
    </form>
  {/if}
</div>

<style>
  h2 {
    margin: 0 0 0.75rem;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .current {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .username {
    flex: 1;
    min-width: 0;
    color: var(--text);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .edit {
    flex: none;
    background: none;
    color: var(--muted);
    padding: 0.35rem 0.6rem;
  }
  .edit:hover {
    color: var(--text);
  }
  .row {
    display: flex;
    gap: 0.5rem;
  }
  /* Let the input shrink inside the narrow rail (flex min-width: auto otherwise overflows). */
  .row input {
    min-width: 0;
  }
  .link {
    background: none;
    color: var(--muted);
    padding: 0.35rem 0;
    font-size: 0.85rem;
    margin-top: 0.4rem;
  }
  .link:hover {
    color: var(--text);
  }
  .ok {
    color: var(--ok);
    font-size: 0.85rem;
    margin: 0.4rem 0 0;
  }
  .err {
    color: var(--err, #f87171);
    font-size: 0.85rem;
    margin: 0.4rem 0 0;
  }
</style>
