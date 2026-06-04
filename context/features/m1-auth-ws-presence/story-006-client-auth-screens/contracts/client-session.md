#contract

# Contract: Client auth/session store (story 006 → story 007)

Authoritative shape of the client-side auth/session state. Story 007 (WS connect +
presence) reads this to open and authenticate the WebSocket. The store is a Svelte 5
runes singleton; it does **not** touch the keychain itself — call sites pair
`applySession`/`clear` with the story-005 `setSession`/`deleteSession` wrapper.

## Module & import path

File: `client/src/lib/authStore.svelte.ts` (a `*.svelte.ts` module, mandatory because
`$state`/`$derived` run outside a `.svelte` component).

```ts
import { store } from "./lib/authStore.svelte"; // bundler resolution — NO .ts/.js suffix
```

The single named export is `store`. All fields are reactive: read them inside Svelte
markup, `$derived`, or `$effect` and they update automatically after login/refresh/logout.

## Reactive fields (read-only getters)

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `store.currentUser` | `PublicUser \| null` | The signed-in user, or `null` when unauthenticated. `PublicUser = { id: number; username: string; displayName: string \| null; createdAt: number }`. |
| `store.sessionToken` | `string \| null` | Raw opaque session token. The Bearer credential for REST **and** the WS connect credential. `null` when unauthenticated. |
| `store.serverUrl` | `string` | Persisted base URL (seeded from `getStoredServerUrl()` → localStorage key `dc:serverUrl`, falling back to `DEFAULT_SERVER_URL`). Always a non-null string. |
| `store.expiresAt` | `number \| null` | Session expiry, epoch ms (from the session body). `null` when unauthenticated. |
| `store.isAuthed` | `boolean` (derived) | `sessionToken !== null && currentUser !== null`. |

`PublicUser` and `SessionResponse` are defined in `client/src/lib/types.ts`:

```ts
export interface PublicUser {
  id: number;
  username: string;
  displayName: string | null;
  createdAt: number;
}
export interface SessionResponse {
  session: string; // raw opaque token
  expiresAt: number; // epoch ms
  user: PublicUser;
}
```

## Mutators

```ts
// Set user/token/expiry after a successful register, login, or refresh.
store.applySession(body: SessionResponse): void;

// Update the server URL and persist it to localStorage (key "dc:serverUrl").
store.setServerUrl(url: string): void;

// Wipe user/token/expiry. Leaves serverUrl intact so login remembers the server.
store.clear(): void;
```

Note: `applySession` does **not** write the keychain; pair it with
`setSession(body.session)`. Likewise `clear()` does **not** delete the keychain; pair
it with `deleteSession()`.

## How story 007 consumes this

1. **Guard:** only attempt the WS connect when `store.isAuthed` (or at least
   `store.sessionToken !== null`).
2. **Derive the WS URL** from `store.serverUrl`. Swap the HTTP scheme for WS, e.g.
   `new URL(store.serverUrl)` then map `http:`→`ws:` / `https:`→`wss:` and append the
   gateway path (per the story-004 WS contract). Example:

   ```ts
   import { store } from "./lib/authStore.svelte";

   function wsUrl(): string {
     const u = new URL(store.serverUrl);
     u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
     u.pathname = "/ws"; // confirm exact path against the story-004 WS contract
     return u.toString();
   }
   ```

3. **Authenticate the connect** using `store.sessionToken` as the Bearer/connect
   credential exactly as the WS gateway expects (story 004 contract).
4. **Highlight self** in the member/presence list via `store.currentUser?.id` /
   `store.currentUser?.username`.
5. **On an auth-failure WS close** (the gateway rejected the token, e.g. it was revoked
   server-side), call `store.clear()` **and** `deleteSession()` (from
   `./lib/session`); the root `App.svelte` view then falls back to login. Do not
   silently retry an auth-failed close with the same dead token.

## Where the store is populated (story 006 behavior, for reference)

- **Launch** (`App.svelte`): `getSession()` → if a token exists,
  `validateSession(serverUrl, token)` (`POST /api/refresh`, which **rotates** the
  token). On success: `setSession(newToken)` + `store.applySession(rotatedBody)` →
  view `app`. On `unauthorized`: `deleteSession()` + `store.clear()` → login. On
  network failure: keep the token, fall back to login.
- **Register/Login:** on success `setSession(body.session)` + `store.applySession(body)`.
- **Logout:** best-effort `POST /api/logout`, then unconditional `deleteSession()` +
  `store.clear()` → login.
