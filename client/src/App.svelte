<script lang="ts">
  import { DEFAULT_SERVER_URL } from "./lib/config";

  type Status = "idle" | "checking" | "ok" | "error";

  let serverUrl = $state(DEFAULT_SERVER_URL);
  let status = $state<Status>("idle");
  let detail = $state("");

  async function checkServer(): Promise<void> {
    status = "checking";
    detail = "";
    try {
      const res = await fetch(new URL("/health", serverUrl));
      const body = (await res.json()) as { status?: string; service?: string };
      if (res.ok && body.status === "ok") {
        status = "ok";
        detail = body.service ?? "server";
      } else {
        status = "error";
        detail = `Unexpected response (${res.status})`;
      }
    } catch (err) {
      status = "error";
      detail = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<main>
  <h1>discord-clone</h1>
  <p class="tagline">M0 skeleton — see SPEC.md for the roadmap.</p>

  <section class="card">
    <label for="server">Server URL</label>
    <div class="row">
      <input id="server" bind:value={serverUrl} placeholder="http://localhost:8080" />
      <button onclick={checkServer} disabled={status === "checking"}>
        {status === "checking" ? "Checking…" : "Test connection"}
      </button>
    </div>
    {#if status === "ok"}
      <p class="ok">✓ Connected to {detail}</p>
    {:else if status === "error"}
      <p class="err">✗ {detail}</p>
    {/if}
  </section>
</main>
