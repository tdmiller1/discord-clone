<script lang="ts">
  import { store } from "./authStore.svelte";
  import { cachedObjectUrl, loadAttachmentImage } from "./attachmentImages";

  // A circular profile picture. When `avatarId` is set, the bytes are fetched
  // (Bearer-auth'd) and shown as an object URL — reusing the same id-keyed blob
  // cache as inline message images (a new upload gets a new id, so the picture
  // updates without any cache invalidation). Otherwise it falls back to the
  // user's initial on a color derived from their name, so every member always
  // renders something stable.
  let {
    avatarId,
    name,
    size = 36,
  }: { avatarId: number | null; name: string; size?: number } = $props();

  type Status = "idle" | "loading" | "ok" | "error";

  let status = $state<Status>("idle");
  let objectUrl = $state<string | null>(null);

  const initial = $derived((name.trim()[0] ?? "?").toUpperCase());

  // Deterministic hue from the name so a given user keeps the same fallback color.
  const hue = $derived.by(() => {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  });

  // (Re)load whenever the avatar id or the token changes. Mirrors InlineImage:
  // capture a cancelled flag for stale resolves, and on cleanup revoke only a
  // superseded/uncached URL — never the still-cached (shared) one that
  // clearCache() owns on logout.
  $effect(() => {
    const id = avatarId;
    const token = store.sessionToken;

    if (id === null) {
      status = "idle";
      objectUrl = null;
      return;
    }
    if (token === null) {
      status = "error";
      objectUrl = null;
      return;
    }

    let cancelled = false;
    status = "loading";
    objectUrl = null;

    void loadAttachmentImage({ serverUrl: store.serverUrl, token, attachmentId: id }).then(
      (result) => {
        if (cancelled) return;
        if (result.ok) {
          objectUrl = result.objectUrl;
          status = "ok";
        } else {
          objectUrl = null;
          status = "error";
        }
      },
    );

    return () => {
      cancelled = true;
      if (objectUrl !== null && objectUrl !== cachedObjectUrl(id)) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  });
</script>

<div
  class="avatar"
  style="width: {size}px; height: {size}px; font-size: {Math.round(size * 0.42)}px;"
>
  {#if status === "ok" && objectUrl !== null}
    <img src={objectUrl} alt={name} />
  {:else}
    <span
      class="fallback"
      style="background: hsl({hue} 45% 38%);"
      aria-label={name}
    >
      {initial}
    </span>
  {/if}
</div>

<style>
  .avatar {
    flex: none;
    border-radius: 50%;
    overflow: hidden;
    display: block;
  }
  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    /* Round the <img> itself rather than relying on the parent's overflow:hidden +
       border-radius to clip it — WebKitGTK (Tauri's Linux webview) doesn't clip a
       replaced element to an ancestor's border-radius, so a real uploaded photo would
       otherwise render square. Matches InlineImage, which rounds the <img> directly. */
    border-radius: inherit;
  }
  .fallback {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 600;
    line-height: 1;
    user-select: none;
  }
</style>
