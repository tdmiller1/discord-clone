<script lang="ts">
  import { register, type AuthErrorCode } from "./auth";
  import { store } from "./authStore.svelte";
  import { setSession } from "./session";

  let { onAuthed, onShowLogin } = $props<{
    onAuthed: () => void;
    onShowLogin: () => void;
  }>();

  type Status = "idle" | "submitting" | "error";

  let serverUrl = $state(store.serverUrl);
  let token = $state("");
  let username = $state("");
  let password = $state("");
  let status = $state<Status>("idle");
  let errorMsg = $state("");

  const canSubmit = $derived(
    status !== "submitting" &&
      serverUrl.trim() !== "" &&
      token.trim() !== "" &&
      username.trim() !== "" &&
      password !== "",
  );

  function messageFor(code: AuthErrorCode): string {
    switch (code) {
      case "invalid_token":
        return "Invite token is invalid, used, or revoked.";
      case "username_taken":
        return "That username is already taken.";
      case "bad_request":
        return "Check your input (password must be at least 8 characters).";
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

    if (password.length < 8) {
      status = "error";
      errorMsg = "Password must be at least 8 characters.";
      return;
    }

    status = "submitting";
    errorMsg = "";

    const url = serverUrl.trim();
    store.setServerUrl(url);

    const result = await register({
      serverUrl: url,
      token: token.trim(),
      username: username.trim(),
      password,
    });

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
  <h1>Create your account</h1>
  <p class="tagline">Enter your invite token to register.</p>

  <form class="card" onsubmit={submit}>
    <label for="reg-server">Server URL</label>
    <div class="row">
      <input id="reg-server" bind:value={serverUrl} placeholder="http://localhost:8080" />
    </div>

    <label for="reg-token">Invite token</label>
    <div class="row">
      <input id="reg-token" bind:value={token} placeholder="invite token" />
    </div>

    <label for="reg-username">Username</label>
    <div class="row">
      <input id="reg-username" bind:value={username} placeholder="username" autocomplete="username" />
    </div>

    <label for="reg-password">Password</label>
    <div class="row">
      <input
        id="reg-password"
        type="password"
        bind:value={password}
        placeholder="at least 8 characters"
        autocomplete="new-password"
      />
    </div>

    <div class="row">
      <button type="submit" disabled={!canSubmit}>
        {status === "submitting" ? "Creating…" : "Register"}
      </button>
    </div>

    {#if status === "error"}
      <p class="err">{errorMsg}</p>
    {/if}
  </form>

  <p class="switch">
    Already have an account?
    <button type="button" class="link" onclick={onShowLogin}>Log in</button>
  </p>
</main>

<style>
  .switch {
    margin-top: 1rem;
    color: var(--muted);
  }
  .link {
    background: none;
    color: var(--accent);
    padding: 0;
    font-weight: 600;
  }
</style>
