<script lang="ts">
  import { onMount } from "svelte";
  import Login from "./lib/Login.svelte";
  import Presence from "./lib/Presence.svelte";
  import Register from "./lib/Register.svelte";
  import { logout, validateSession } from "./lib/auth";
  import { store } from "./lib/authStore.svelte";
  import { channelStore } from "./lib/channelStore.svelte";
  import { gateway } from "./lib/gateway.svelte";
  import { deleteSession, getSession, setSession } from "./lib/session";
  import { clearCache as clearAttachmentImages } from "./lib/attachmentImages";

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
    // Tear down the socket explicitly so it can't reconnect during the view switch
    // (idempotent — Presence's onDestroy also disconnects on unmount).
    gateway.disconnect();
    channelStore.clear();
    clearAttachmentImages();
    const token = store.sessionToken;
    if (token) await logout(store.serverUrl, token);
    await deleteSession();
    store.clear();
    view = "login";
  }

  /** A 4001 WS close: the session is already dead server-side — clear it + return to login. */
  async function handleSessionInvalid(): Promise<void> {
    gateway.clearAuthFailed();
    channelStore.clear();
    clearAttachmentImages();
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
  <Presence onLogout={handleLogout} onSessionInvalid={handleSessionInvalid} />
{/if}
