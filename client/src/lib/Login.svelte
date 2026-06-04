<script lang="ts">
  import { login, type AuthErrorCode } from "./auth";
  import { store } from "./authStore.svelte";
  import { setSession } from "./session";

  let { onAuthed, onShowRegister } = $props<{
    onAuthed: () => void;
    onShowRegister: () => void;
  }>();

  type Status = "idle" | "submitting" | "error";

  let serverUrl = $state(store.serverUrl);
  let editServer = $state(false);
  let username = $state("");
  let password = $state("");
  let status = $state<Status>("idle");
  let errorMsg = $state("");

  const canSubmit = $derived(
    status !== "submitting" &&
      serverUrl.trim() !== "" &&
      username.trim() !== "" &&
      password !== "",
  );

  function messageFor(code: AuthErrorCode): string {
    switch (code) {
      case "invalid_credentials":
        return "Incorrect username or password.";
      case "bad_request":
        return "Check your input and try again.";
      case "rate_limited":
        return "Too many attempts — try again shortly.";
      case "network":
        return "Could not reach the server.";
      default:
        return "Something went wrong. Please try again.";
    }
  }

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;

    status = "submitting";
    errorMsg = "";

    const url = serverUrl.trim();
    store.setServerUrl(url);

    const result = await login({ serverUrl: url, username: username.trim(), password });

    if (result.ok) {
      await setSession(result.data.session);
      store.applySession(result.data);
      onAuthed();
      return;
    }

    status = "error";
    errorMsg = messageFor(result.error);
  }
</script>

<main>
  <h1>Welcome back</h1>
  <p class="tagline">Log in to continue.</p>

  <form class="card" onsubmit={submit}>
    {#if editServer}
      <label for="login-server">Server URL</label>
      <div class="row">
        <input id="login-server" bind:value={serverUrl} placeholder="http://localhost:8080" />
      </div>
    {:else}
      <p class="server-line">
        Server: <span class="server-url">{serverUrl}</span>
        <button type="button" class="link" onclick={() => (editServer = true)}>change</button>
      </p>
    {/if}

    <label for="login-username">Username</label>
    <div class="row">
      <input
        id="login-username"
        bind:value={username}
        placeholder="username"
        autocomplete="username"
      />
    </div>

    <label for="login-password">Password</label>
    <div class="row">
      <input
        id="login-password"
        type="password"
        bind:value={password}
        placeholder="password"
        autocomplete="current-password"
      />
    </div>

    <div class="row">
      <button type="submit" disabled={!canSubmit}>
        {status === "submitting" ? "Logging in…" : "Log in"}
      </button>
    </div>

    {#if status === "error"}
      <p class="err">{errorMsg}</p>
    {/if}
  </form>

  <p class="switch">
    Have an invite token?
    <button type="button" class="link" onclick={onShowRegister}>Register</button>
  </p>
</main>

<style>
  .switch {
    margin-top: 1rem;
    color: var(--muted);
  }
  .server-line {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0 0 0.75rem;
  }
  .server-url {
    color: var(--text);
  }
  .link {
    background: none;
    color: var(--accent);
    padding: 0;
    font-weight: 600;
  }
</style>
