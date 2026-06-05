<script lang="ts">
  import { store } from "./authStore.svelte";
  import { cachedObjectUrl, loadAttachmentImage } from "./attachmentImages";
  import type { PublicAttachment } from "./types";

  type Status = "loading" | "ok" | "error";

  let { attachment }: { attachment: PublicAttachment } = $props();

  let status = $state<Status>("loading");
  let objectUrl = $state<string | null>(null);

  // CSS variable to reserve layout space from the probed dimensions (nullable) so the
  // row doesn't reflow when the blob resolves. Skipped when width/height are absent.
  const aspectRatio = $derived(
    attachment.width !== null && attachment.height !== null && attachment.height > 0
      ? `${attachment.width} / ${attachment.height}`
      : null,
  );

  // Load the bytes whenever the attachment id (or token) changes. Capture the id and a
  // cancelled flag to guard a stale resolve, and revoke any superseded/uncached URL on
  // cleanup — never the still-cached (shared) URL, which clearCache() owns on logout.
  $effect(() => {
    const id = attachment.id;
    const token = store.sessionToken;
    let cancelled = false;

    status = "loading";
    objectUrl = null;

    if (token === null) {
      status = "error";
      return;
    }

    void loadAttachmentImage({
      serverUrl: store.serverUrl,
      token,
      attachmentId: id,
    }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        objectUrl = result.objectUrl;
        status = "ok";
      } else {
        objectUrl = null;
        status = "error";
      }
    });

    return () => {
      cancelled = true;
      if (objectUrl !== null && objectUrl !== cachedObjectUrl(id)) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  });
</script>

<div class="inline-image">
  {#if status === "ok" && objectUrl !== null}
    <img
      src={objectUrl}
      alt={attachment.filename}
      loading="lazy"
      style={aspectRatio !== null ? `aspect-ratio: ${aspectRatio};` : undefined}
    />
  {:else if status === "error"}
    <div class="img-error">Image unavailable</div>
  {:else}
    <div
      class="img-loading"
      style={aspectRatio !== null ? `aspect-ratio: ${aspectRatio};` : undefined}
    >
      Loading image…
    </div>
  {/if}
</div>

<style>
  .inline-image img {
    max-width: min(400px, 100%);
    max-height: 320px;
    height: auto;
    width: auto;
    object-fit: contain;
    border-radius: 6px;
    display: block;
  }
  .img-loading,
  .img-error {
    display: flex;
    align-items: center;
    justify-content: center;
    width: min(240px, 100%);
    max-width: min(400px, 100%);
    border-radius: 6px;
    font-size: 0.8rem;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.04);
    padding: 0.75rem;
  }
  .img-loading {
    min-height: 4rem;
  }
  .img-error {
    color: var(--err, #f87171);
  }
</style>
