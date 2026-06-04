<script lang="ts">
  import { onMount } from "svelte";
  import Login from "./lib/Login.svelte";
  import Register from "./lib/Register.svelte";
  import { logout, validateSession } from "./lib/auth";
  import { store } from "./lib/authStore.svelte";
  import { deleteSession, getSession, setSession } from "./lib/session";

  type View = "loading" | "register" | "login" | "app";

  let view = $state<View>("loading");

  /** Launch bootstrap: read the stored token, validate via refresh, route accordingly. */
  async function bootstrap(): Promise<void> {
    const token = await getSession();
    if (!token) {
      // No stored token: first launch / returning user → login (register affordance shown).
      view = "login";
      return;
    }

    const result = await validateSession(store.serverUrl, token);
    if (result.ok) {
      // refresh rotates the token — persist the NEW one or the next relaunch fails.
      await setSession(result.data.session);
      store.applySession(result.data);
      view = "app";
      return;
    }

    if (result.error === "unauthorized") {
      // Stale/expired token: drop it and send the user to login.
      await deleteSession();
      store.clear();
    }
    // network or any other failure: keep the token, but don't strand on loading.
    view = "login";
  }

  async function handleLogout(): Promise<void> {
    const token = store.sessionToken;
    if (token) await logout(store.serverUrl, token);
    await deleteSession();
    store.clear();
    view = "login";
  }

  onMount(() => {
    void bootstrap();
  });
</script>

{#if view === "loading"}
  <main>
    <h1>discord-clone</h1>
    <p class="tagline">Loading…</p>
  </main>
{:else if view === "register"}
  <Register onAuthed={() => (view = "app")} onShowLogin={() => (view = "login")} />
{:else if view === "login"}
  <Login onAuthed={() => (view = "app")} onShowRegister={() => (view = "register")} />
{:else}
  <main>
    <h1>discord-clone</h1>
    <p class="tagline">Signed in as {store.currentUser?.username ?? "user"}.</p>
    <section class="card">
      <p class="muted">Channels and presence arrive in the next milestone.</p>
      <div class="row">
        <button onclick={handleLogout}>Log out</button>
      </div>
    </section>
  </main>
{/if}

<style>
  .muted {
    color: var(--muted);
    margin: 0 0 1rem;
  }
</style>
