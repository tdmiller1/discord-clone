#research

# Research: Client — register & login screens + session persistence

## Files to Touch

### Likely Modified
- `client/src/App.svelte` — today this is the single M0 "ping the server" screen (`Status` union, `fetch(new URL("/health", serverUrl))`). It becomes the **root view switch**: on mount it bootstraps the session (keychain + validate), then renders one of three views — `loading`, the auth screens (register/login), or the authed/app view. Most of the current ping logic is removed; the server-URL input pattern is reused inside the register screen.
- `client/src/lib/config.ts` — keep `DEFAULT_SERVER_URL` as the seed value, but add a small persisted-server-URL helper (localStorage get/set) here, or in a new `serverUrl.ts` (see Decisions). `DEFAULT_SERVER_URL` is now only the fallback when nothing is stored.

### Likely Created
- `client/src/lib/auth.ts` — typed REST client for the auth-api contract (003): `register({ serverUrl, token, username, password })`, `login({ serverUrl, username, password })`, `logout(serverUrl, sessionToken)`, plus a lightweight `validateSession(serverUrl, sessionToken)` used at launch. Maps HTTP status + `{ error }` bodies to a discriminated result type so screens can show specific errors (`invalid_token`, `username_taken`, `invalid_credentials`, `429`, network failure). Centralizes the `Authorization: Bearer` header and `fetch(new URL(path, serverUrl))` URL-building.
- `client/src/lib/authStore.svelte.ts` — the client auth/session store the story's acceptance criterion #7 and **story 007** require. A runes-based module (`.svelte.ts` so `$state` works outside a component) exposing reactive `currentUser`, `sessionToken`, `serverUrl`, and a derived `isAuthed`, plus `applySession(...)` / `clear()` mutators. This is the shape `contracts/client-session.md` documents.
- `client/src/lib/types.ts` — mirror the contract's `PublicUser` and the session-response body (`{ session, expiresAt, user }`) as TS interfaces so `auth.ts` and the store are typed. (Could also live inside `auth.ts`; splitting keeps the contract shapes discoverable.)
- `client/src/lib/Register.svelte`, `client/src/lib/Login.svelte` — the two form components (could instead be inlined in `App.svelte`; splitting is cleaner given two distinct field sets). Decision below leans to separate components but the plan may inline.
- `client/src/contracts/` is N/A — the deliverable contract goes in this story dir: `context/features/m1-auth-ws-presence/story-006-client-auth-screens/contracts/client-session.md`.

### Read-Only Reference (patterns to follow)
- `client/src/App.svelte` (current) — Svelte 5 runes idiom to mirror: `let x = $state(...)`, `onclick={fn}`, `bind:value={x}`, `disabled={...}`, the `{#if}` view branching, and the `try/catch` around `fetch` that sets a status + detail string. Reuse this exact shape for forms.
- `client/src/lib/session.ts` — the story-005 keychain wrapper, **already implemented** and matching its contract. Import `{ getSession, setSession, deleteSession }` from `"./lib/session"` (no extension). Never call `invoke` directly.
- `client/src/lib/config.ts` — `DEFAULT_SERVER_URL` export style (single named const, JSDoc one-liner).
- `client/src/app.css` — global CSS vars/classes to reuse: `.card`, `.row`, `label`, `input`, `button`, `.ok`, `.err`, and the `--accent/--ok/--err/--muted` palette. New screens should lean on these rather than scoped styles.
- `context/.../story-003-auth-rest-api/contracts/auth-api.md` — endpoint table, request/response bodies, error codes, Bearer scheme (authoritative; do not deviate).
- `context/.../story-005-client-keychain-shell/contracts/keychain-commands.md` — wrapper API + non-Tauri degradation (`getSession()` → `null` in plain browser, so dev-in-browser always lands on auth screens).

## Existing Patterns

- **Svelte 5 runes only.** `App.svelte` uses `let serverUrl = $state(DEFAULT_SERVER_URL)`, `let status = $state<Status>("idle")`, event attrs `onclick={checkServer}`, two-way `bind:value`, and conditional render via `{#if status === "ok"} ... {:else if ...}`. No `export let`, no `writable` stores, no `on:click`. `svelte.config.js` + `svelte@^5.19` confirm Svelte 5.
- **Discriminated string-union status pattern.** `type Status = "idle" | "checking" | "ok" | "error"` drives both control flow and rendering. Reuse this for form submit state (e.g. `"idle" | "submitting" | "error"`) and for the top-level view (`"loading" | "register" | "login" | "app"`).
- **`fetch(new URL(path, serverUrl))`** is the established HTTP call shape; responses are read with `(await res.json()) as { ... }` and guarded by `res.ok`. The auth client should generalize this (POST + JSON body + `Authorization` header).
- **Client module resolution is `bundler`, not NodeNext.** `client/tsconfig.json` sets `"moduleResolution": "bundler"` and existing imports omit extensions (`from "./lib/config"`, `from "./lib/session"`). **Do NOT add `.js` extensions on the client** — the server-side `.js`-suffix rule from CLAUDE.md does not apply here. Modules that use runes outside a `.svelte` file must be named `*.svelte.ts` (Svelte 5 requirement) — hence `authStore.svelte.ts`.
- **`lib/` naming:** lowercase filenames for plain TS modules (`config.ts`, `session.ts`); PascalCase for Svelte components (`App.svelte`).
- **Single mount point:** `main.ts` mounts `App.svelte` into `#app`; no router. The "screen switch" is a `$state` view variable inside `App.svelte`, not a routing lib.
- **Static gate:** `npm run typecheck` runs server `tsc --noEmit` + client `svelte-check`. No test runner; all ACs must be verifiable via typecheck + running the client (Tauri) or `cd client && npm run dev` in a browser.

## Data Flow

**Launch / bootstrap** (in `App.svelte` `$effect` or an async init on mount):
1. Read persisted server URL from `localStorage` (key e.g. `dc:serverUrl`), fall back to `DEFAULT_SERVER_URL`.
2. `getSession()` (keychain) → `string | null`. In plain-browser dev this is always `null`.
3. If a token exists, validate it with a quick authed call — `POST /api/refresh` (Bearer) or `GET`-style probe. The auth-api contract offers no read endpoint; `POST /api/refresh` is the cheapest authed call and **rotates** the token, so on success we must store the *new* `session`/`expiresAt`/`user` from its response body. (Alternatively story 007 validates lazily by opening the WS; see Open Questions — but AC#1 says "a quick authed call or WS connect", and WS is out of scope here, so refresh is the in-scope validator.)
4. On valid session → populate the auth store (`applySession`) and switch view to `app`. On `401`/network failure with a stored token → `deleteSession()`, clear store, show **login** (token was stale). On no token → show **register** (first launch) or **login** (returning user); default to login with a "first time? register" affordance, since register needs an invite token.

**Register flow:**
1. Register screen fields: server URL (prefilled from persisted/default), invite token, username, password. Reuse `.card`/`.row`/`label`/`input`.
2. On submit → persist the entered server URL to localStorage → `auth.register(...)` → `POST /api/register { token, username, password }`.
3. Success (`201` → `{ session, expiresAt, user }`): `setSession(session)` (keychain), `applySession(user, session, expiresAt, serverUrl)`, switch to `app`.
4. Errors surfaced per contract: `400 Bad Request` (malformed/short password — also validate client-side: password ≥ 8), `400 invalid_token` ("invite token invalid, used, or revoked"), `409 username_taken` ("username already taken"), `429` ("too many attempts, try again shortly"), network error ("could not reach server").

**Login flow:**
1. Login screen fields: username + password; server URL remembered (prefilled, optionally editable via a small "change server" toggle).
2. On submit → `auth.login(...)` → `POST /api/login { username, password }`.
3. Success (`200` → session body): `setSession(session)`, `applySession(...)`, switch to `app`.
4. Errors: `401 invalid_credentials` (uniform — covers wrong password, unknown user, **and disabled account**; surface one message: "incorrect username or password"), `400`, `429`, network error.

**Logout flow:**
1. From the authed view → `auth.logout(serverUrl, sessionToken)` → `POST /api/logout` (Bearer); ignore its outcome for UX (best-effort server revoke).
2. Always `deleteSession()` (keychain) + `store.clear()` → switch to **login**.

**Server-URL persistence:** the keychain wrapper is token-only by contract, so the server URL lives in **`localStorage`** (key `dc:serverUrl`). Rationale: it is non-secret config, must survive relaunch, the keychain stores exactly one token entry per the 005 contract (no room for URL), and localStorage is the standard webview persistence with zero new Tauri commands. `DEFAULT_SERVER_URL` seeds it on first run. (Note: under Tauri the webview's localStorage persists across launches; in plain-browser dev it also persists per-origin.)

**Auth/session store shape (`authStore.svelte.ts`, documented in `client-session.md` for story 007):**
```ts
// reactive module-level runes state
currentUser:  PublicUser | null   // { id, username, displayName, createdAt }
sessionToken: string | null       // raw opaque token (Bearer + WS connect credential)
serverUrl:    string              // persisted base URL (seeded from DEFAULT_SERVER_URL)
expiresAt:    number | null       // epoch ms, from the session body
isAuthed:     boolean             // derived: sessionToken !== null && currentUser !== null
applySession(user, token, expiresAt): void   // set after register/login/refresh + persist token
setServerUrl(url): void                       // persist to localStorage
clear(): void                                 // wipe state (logout / stale-session)
```
Story 007 reads `sessionToken` (to open + authenticate the WS), `serverUrl` (to derive the `ws(s)://` URL), and `currentUser` (to highlight self in the member list); on an auth-failure WS close it calls `clear()` + `deleteSession()` and the view falls back to login.

## Decisions Made

1. **Session validation at launch uses `POST /api/refresh`.** It is the only authed, side-effect-cheap endpoint in the 003 contract and returns a fresh full session body. AC#1 explicitly permits "a quick authed call." We rotate-and-store the returned token on success; on `401` we treat the stored token as stale (clear keychain + store, go to login). This keeps WS entirely in story 007.
2. **Server URL persists in `localStorage`** (`dc:serverUrl`), not the keychain. The keychain contract is strictly token-only and single-entry; server URL is non-secret config. `DEFAULT_SERVER_URL` remains the first-run seed.
3. **New `client/src/lib/auth.ts` REST client** wrapping the four endpoints + a result type, rather than inline `fetch` calls in components. Centralizes Bearer headers, URL building, and contract-accurate error mapping; keeps components declarative and the contract surface in one file.
4. **Auth state lives in a `*.svelte.ts` runes module** (`authStore.svelte.ts`), exported as reactive state — not Svelte stores (`writable`) — to stay consistent with the runes-only convention and to give story 007 a clean import. The `.svelte.ts` extension is required for `$state` outside components.
5. **Top-level view switch is a `$state` union in `App.svelte`** (`"loading" | "register" | "login" | "app"`); no router dependency added (matches single-mount, dependency-light setup).
6. **Default unauthenticated screen is login**, with a visible "register with an invite token" path, because returning users are the common case and register requires an invite token they may not have. (Plan may revisit ordering; either is contract-compatible.)
7. **Client-side password length pre-check (≥ 8)** mirrors the server's schema (password 8..256) to give a friendly error before the round-trip, while still handling the server's `400 Bad Request` defensively.
8. **No new npm dependencies.** Everything uses the existing `@tauri-apps/api` (via session.ts), `fetch`, `localStorage`, and Svelte 5 runes.

## Open Questions

None that block planning. One note for the planner: AC#1 allows validating the stored session via "a quick authed call **or** WS connect"; this story chooses the authed call (`/api/refresh`) since the WS belongs to story 007. If the team would rather defer all validation to the WS handshake, the launch path would optimistically enter `app` with the stored token and let story 007 bounce to login on an auth-failure close — but that crosses the story boundary, so the in-scope choice is `/api/refresh`.
