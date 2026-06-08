<script lang="ts">
  import { createInvite } from "./auth";
  import { store } from "./authStore.svelte";
  import { inviteLink } from "./config";

  // idle → minting → (copied | manual | error). `manual` is the clipboard-blocked fallback
  // (no user gesture / insecure context) where we show the link for the user to copy by hand.
  type Status = "idle" | "minting" | "copied" | "manual" | "error";

  let status = $state<Status>("idle");
  let link = $state("");
  let errorMsg = $state("");

  async function invite(): Promise<void> {
    if (status === "minting") return;
    status = "minting";
    errorMsg = "";
    link = "";

    const result = await createInvite(store.serverUrl, store.sessionToken!);
    if (!result.ok) {
      status = "error";
      errorMsg =
        result.error === "network"
          ? "Could not reach the server."
          : result.error === "unauthorized"
            ? "Your session expired — log in again."
            : "Could not create an invite. Try again.";
      return;
    }

    link = inviteLink(result.token);
    try {
      await navigator.clipboard.writeText(link);
      status = "copied";
    } catch {
      status = "manual";
    }
  }
</script>

<div class="invite">
  <button type="button" class="invite-btn" onclick={invite} disabled={status === "minting"}>
    {status === "minting" ? "Creating invite…" : "Invite a friend"}
  </button>

  {#if status === "copied"}
    <p class="ok">✓ Invite link copied — send it to your friend. It works once.</p>
  {:else if status === "manual"}
    <p class="hint">Copy this single-use invite link:</p>
    <input
      class="link"
      readonly
      value={link}
      onfocus={(e) => e.currentTarget.select()}
      aria-label="Invite link"
    />
  {:else if status === "error"}
    <p class="err">{errorMsg}</p>
  {/if}
</div>

<style>
  .invite {
    margin-bottom: 0.75rem;
  }
  .invite-btn {
    width: 100%;
  }
  .ok {
    color: var(--ok);
    font-size: 0.85rem;
    margin: 0.4rem 0 0;
  }
  .hint {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0.4rem 0 0.25rem;
  }
  .link {
    width: 100%;
    font-size: 0.8rem;
  }
  .err {
    color: var(--err, #f87171);
    font-size: 0.85rem;
    margin: 0.4rem 0 0;
  }
</style>
