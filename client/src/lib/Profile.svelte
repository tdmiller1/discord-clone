<script lang="ts">
  import { store } from "./authStore.svelte";
  import { updateAvatar, updateUsername, type AuthErrorCode, type AvatarErrorCode } from "./auth";
  import Avatar from "./Avatar.svelte";
  import { theme, THEME_COLORS, type ThemeKey } from "./themeStore.svelte";

  let {
    onLogout,
    connected = false,
    status: connStatus = "",
  } = $props<{ onLogout: () => void; connected?: boolean; status?: string }>();

  // idle: show the current name + Edit. editing: name field + Save/Cancel. saving: in-flight.
  type Status = "idle" | "editing" | "saving";

  let status = $state<Status>("idle");
  let draft = $state("");
  let err = $state("");
  let saved = $state(false);

  // Avatar upload runs independently of the username editor (own in-flight + feedback state).
  let avatarUploading = $state(false);
  let avatarErr = $state("");
  let fileInput = $state<HTMLInputElement | null>(null);

  // Color customization is a collapsible section, hidden until the user opens it.
  let showColors = $state(false);

  function onColorInput(key: ThemeKey, event: Event): void {
    theme.set(key, (event.currentTarget as HTMLInputElement).value);
  }

  const current = $derived(store.currentUser?.username ?? "");
  const avatarId = $derived(store.currentUser?.avatarId ?? null);
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

  function avatarMessageFor(code: AvatarErrorCode): string {
    switch (code) {
      case "file_too_large":
        return "That image is too large.";
      case "invalid_image":
        return "Choose a PNG, JPEG, GIF, or WebP image.";
      case "no_file":
        return "No image was selected.";
      case "rate_limited":
        return "Too many changes — try again in a moment.";
      case "unauthorized":
        return "Your session has expired. Please log in again.";
      case "network":
        return "Could not reach the server.";
      default:
        return "Could not update your picture.";
    }
  }

  async function onFilePicked(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // Reset the input so picking the same file again still fires `change`.
    input.value = "";
    if (file === undefined) return;

    avatarUploading = true;
    avatarErr = "";
    const result = await updateAvatar({
      serverUrl: store.serverUrl,
      token: store.sessionToken!,
      file,
    });
    avatarUploading = false;

    if (result.ok) {
      // Our own picture updates from the response; everyone else gets `user.update`.
      store.setUser(result.user);
    } else {
      avatarErr = avatarMessageFor(result.error);
    }
  }
</script>

<div class="profile">
  <div class="profile-head">
    <div class="title">
      <h2>Your profile</h2>
      <span
        class="dot"
        class:online={connected}
        class:offline={!connected}
        title={connStatus || "Disconnected"}
        aria-label={connStatus || "Disconnected"}
        role="img"
      ></span>
      {#if status === "idle"}
        <button
          type="button"
          class="edit-icon"
          onclick={startEdit}
          aria-label="Edit username"
          title="Edit username"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"
            />
          </svg>
        </button>
      {/if}
    </div>
    <button type="button" class="logout" onclick={onLogout} aria-label="Log out" title="Log out">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M15 17l5-5-5-5M20 12H9M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"
        />
      </svg>
    </button>
  </div>

  <div class="identity">
    <button
      type="button"
      class="avatar-btn"
      onclick={() => fileInput?.click()}
      disabled={avatarUploading}
      aria-label="Change profile picture"
      title="Change profile picture"
    >
      <Avatar {avatarId} name={current} size={48} />
      <span class="avatar-overlay">{avatarUploading ? "…" : "Edit"}</span>
    </button>
    <div class="identity-text">
      <span class="username" title={current}>{current}</span>
      <button
        type="button"
        class="link change-pic"
        onclick={() => fileInput?.click()}
        disabled={avatarUploading}
      >
        {avatarUploading ? "Uploading…" : "Change picture"}
      </button>
    </div>
  </div>
  <input
    bind:this={fileInput}
    class="file-input"
    type="file"
    accept="image/png,image/jpeg,image/gif,image/webp"
    onchange={onFilePicked}
  />
  {#if avatarErr}<p class="err">{avatarErr}</p>{/if}

  {#if status === "idle"}
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

  <div class="colors">
    <button
      type="button"
      class="colors-toggle"
      onclick={() => (showColors = !showColors)}
      aria-expanded={showColors}
      aria-controls="color-list"
    >
      <svg
        class="chevron"
        class:open={showColors}
        viewBox="0 0 24 24"
        width="12"
        height="12"
        aria-hidden="true"
      >
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M9 6l6 6-6 6"
        />
      </svg>
      <span>Customize colors</span>
    </button>

    {#if showColors}
      <div class="color-list" id="color-list">
        {#each THEME_COLORS as color (color.key)}
          <div class="color-row">
            <label class="color-label" for={`color-${color.key}`}>
              <span class="color-name">{color.label}</span>
              <span class="color-hint">{color.hint}</span>
            </label>
            <input
              id={`color-${color.key}`}
              class="swatch"
              type="color"
              value={theme.color(color.key)}
              oninput={(e) => onColorInput(color.key, e)}
              aria-label={`${color.label} color`}
            />
            {#if theme.isOverridden(color.key)}
              <button
                type="button"
                class="link color-reset"
                onclick={() => theme.reset(color.key)}
                aria-label={`Reset ${color.label.toLowerCase()} to default`}
              >
                Reset
              </button>
            {:else}
              <span class="color-default" aria-hidden="true">Default</span>
            {/if}
          </div>
        {/each}
        {#if theme.anyOverridden()}
          <button type="button" class="link reset-all" onclick={() => theme.resetAll()}>
            Reset all colors
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .profile-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }
  /* Heading + connection-status bubble (green when connected, muted when not),
     reusing the same dot treatment as the members list. */
  .title {
    display: flex;
    align-items: center;
    gap: 0.45rem;
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
  h2 {
    margin: 0;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .logout {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    padding: 0;
    background: none;
    color: var(--muted);
    border-radius: 0.35rem;
  }
  .logout:hover {
    background: var(--accent);
    color: var(--text);
  }
  /* Identity row: clickable avatar with a hover "Edit" overlay, plus the name and a
     "Change picture" link — both trigger the hidden file input. */
  .identity {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.6rem;
  }
  .avatar-btn {
    position: relative;
    flex: none;
    padding: 0;
    background: none;
    border-radius: 50%;
    line-height: 0;
    cursor: pointer;
  }
  .avatar-btn:disabled {
    cursor: default;
  }
  .avatar-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-size: 0.7rem;
    font-weight: 600;
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .avatar-btn:hover .avatar-overlay,
  .avatar-btn:focus-visible .avatar-overlay,
  .avatar-btn:disabled .avatar-overlay {
    opacity: 1;
  }
  .identity-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .identity-text .username {
    flex: none;
  }
  .change-pic {
    text-align: left;
    margin-top: 0;
  }
  .file-input {
    display: none;
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
  /* Pencil toggle in the heading, matching the logout icon button's footprint. */
  .edit-icon {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    padding: 0;
    background: none;
    color: var(--muted);
    border-radius: 0.35rem;
  }
  .edit-icon:hover {
    background: var(--accent);
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

  /* Color customization: a collapsible section sitting below the username editor,
     separated by a hairline so it reads as its own group. */
  .colors {
    margin-top: 0.9rem;
    padding-top: 0.7rem;
    border-top: 1px solid var(--bg);
  }
  .colors-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    padding: 0.1rem 0;
    background: none;
    color: var(--muted);
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .colors-toggle:hover {
    color: var(--text);
  }
  .chevron {
    flex: none;
    transition: transform 0.12s ease;
  }
  .chevron.open {
    transform: rotate(90deg);
  }
  .color-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.6rem;
  }
  .color-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .color-label {
    /* Override the global uppercase/muted <label> treatment for these dense rows. */
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    margin: 0;
    text-transform: none;
    letter-spacing: normal;
  }
  .color-name {
    color: var(--text);
    font-size: 0.85rem;
    font-weight: 600;
  }
  .color-hint {
    color: var(--muted);
    font-size: 0.72rem;
  }
  /* Native color input, restyled into a small rounded swatch. */
  .swatch {
    flex: none;
    width: 2rem;
    height: 1.6rem;
    min-width: 0;
    padding: 0;
    border: 1px solid var(--bg);
    border-radius: 0.35rem;
    background: none;
    cursor: pointer;
  }
  .swatch::-webkit-color-swatch-wrapper {
    padding: 2px;
  }
  .swatch::-webkit-color-swatch {
    border: none;
    border-radius: 0.2rem;
  }
  .swatch::-moz-color-swatch {
    border: none;
    border-radius: 0.2rem;
  }
  .color-reset {
    flex: none;
    margin-top: 0;
    font-size: 0.78rem;
  }
  /* Fixed-width placeholder so the swatch column doesn't shift when "Reset" appears. */
  .color-default {
    flex: none;
    width: 2.6rem;
    color: var(--muted);
    font-size: 0.78rem;
    opacity: 0.6;
    text-align: center;
  }
  .reset-all {
    align-self: flex-start;
  }
</style>
