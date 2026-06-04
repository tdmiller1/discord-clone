#plan

# Plan: Client — register & login screens + session persistence

## Summary
Replace the M0 single-screen `App.svelte` ping UI with a runes-driven root view switch (`loading | register | login | app`) that bootstraps the keychain session at launch (validating via `POST /api/refresh`), drives register/login/logout against the story-003 auth REST API through a new typed `lib/auth.ts` client, and exposes the authenticated state via a reusable `lib/authStore.svelte.ts` runes module that story 007 will read to open the WS. The chosen server URL persists in `localStorage` so it is not retyped.

## Implementation Steps

### Step 1: Mirror the contract shapes as client types
**File(s):** `client/src/lib/types.ts`
**Action:** create
**Description:** Define the auth-api contract shapes the REST client and store both depend on, so they are typed and discoverable. Mirrors `PublicUser` and the shared session-response body exactly as documented in `contracts/auth-api.md` (camelCase, epoch-ms numbers). No runes here — a plain `.ts` module (no `.svelte.ts`), no `.js` import suffix.
**Diff shape:**
- Add `export interface PublicUser { id: number; username: string; displayName: string | null; createdAt: number }`.
- Add `export interface SessionResponse { session: string; expiresAt: number; user: PublicUser }` (the body returned by register/login/refresh).

### Step 2: Add the persisted-server-URL helper
**File(s):** `client/src/lib/config.ts`
**Action:** modify
**Description:** Keep `DEFAULT_SERVER_URL` as the first-run seed but add localStorage get/set helpers so the entered server URL survives relaunch (AC#4), replacing the M0 "type it every time" flow. localStorage is used because the keychain contract is token-only/single-entry and the server URL is non-secret config (research Decision 2). Guard `localStorage` access in a try/catch so a non-Tauri/blocked-storage environment degrades to the default rather than throwing.
**Diff shape:**
- Keep `export const DEFAULT_SERVER_URL`.
- Add `const SERVER_URL_KEY = "dc:serverUrl"`.
- Add `export function getStoredServerUrl(): string` — returns `localStorage.getItem(SERVER_URL_KEY) ?? DEFAULT_SERVER_URL` (try/catch → `DEFAULT_SERVER_URL`).
- Add `export function setStoredServerUrl(url: string): void` — `localStorage.setItem(SERVER_URL_KEY, url)` (try/catch → no-op).

### Step 3: Build the typed auth REST client with contract-accurate error mapping
**File(s):** `client/src/lib/auth.ts`
**Action:** create
**Description:** Centralize all four auth endpoints plus a launch-time validator behind one module so components stay declarative and the contract surface lives in one place (research Decision 3). Generalizes the existing `fetch(new URL(path, serverUrl))` shape to POST + JSON body + optional `Authorization: Bearer` header. Each call returns a discriminated result so screens map to specific messages. Plain `.ts` (no runes), bundler imports (no `.js`).
**Diff shape:**
- Add a result union: `type AuthOk = { ok: true; data: SessionResponse }` and `type AuthErr = { ok: false; error: AuthErrorCode }` where `AuthErrorCode = "invalid_token" | "username_taken" | "invalid_credentials" | "bad_request" | "rate_limited" | "network" | "unauthorized" | "unknown"`.
- Add a private `post(serverUrl, path, body?, token?)` helper that builds the URL, sets `Content-Type: application/json` (+ Bearer when `token`), and on a thrown fetch returns `{ ok: false, error: "network" }`. It parses the JSON body defensively (`await res.json().catch(() => ({}))`) and maps `res.status`/`body.error` → an `AuthErrorCode` (see mapping table in API section).
- Add `export async function register({ serverUrl, token, username, password }): Promise<AuthResult>` → `POST /api/register` (no Bearer); success on `201`.
- Add `export async function login({ serverUrl, username, password }): Promise<AuthResult>` → `POST /api/login` (no Bearer); success on `200`.
- Add `export async function logout(serverUrl: string, token: string): Promise<void>` → `POST /api/logout` (Bearer); best-effort, swallow all errors (it is followed unconditionally by keychain+store clear).
- Add `export async function validateSession(serverUrl: string, token: string): Promise<AuthResult>` → `POST /api/refresh` (Bearer); success on `200` returns the rotated session body. On `401` → `{ ok: false, error: "unauthorized" }`; on network failure → `{ ok: false, error: "network" }`.

### Step 4: Create the runes-based auth/session store (the deliverable contract shape)
**File(s):** `client/src/lib/authStore.svelte.ts`
**Action:** create
**Description:** The reactive auth state that AC#7 and story 007 require. Must be a `*.svelte.ts` module because `$state`/`$derived` are used outside a `.svelte` component (Svelte 5 requirement; research Decision 4). Exposes reactive `currentUser`, `sessionToken`, `serverUrl`, `expiresAt`, a derived `isAuthed`, and `applySession` / `setServerUrl` / `clear` mutators. The store seeds `serverUrl` from `getStoredServerUrl()` and `setServerUrl` persists through `setStoredServerUrl()` so persistence is owned in one place. The store does NOT touch the keychain itself (callers pair `applySession`/`clear` with `setSession`/`deleteSession`) — keeps the keychain side-effect explicit at the call sites.
**Diff shape:**
- Add module-level `let _currentUser = $state<PublicUser | null>(null)`, `_sessionToken = $state<string | null>(null)`, `_serverUrl = $state<string>(getStoredServerUrl())`, `_expiresAt = $state<number | null>(null)`.
- Export reactive accessors (object with getters, or a `$state`-backed singleton object) for `currentUser`, `sessionToken`, `serverUrl`, `expiresAt`, and a derived `isAuthed = _sessionToken !== null && _currentUser !== null`.
- Add `applySession(body: SessionResponse): void` — set `_currentUser = body.user`, `_sessionToken = body.session`, `_expiresAt = body.expiresAt`.
- Add `setServerUrl(url: string): void` — set `_serverUrl = url` and call `setStoredServerUrl(url)`.
- Add `clear(): void` — reset user/token/expiresAt to `null` (leaves `serverUrl` intact so login keeps the remembered server).

### Step 5: Build the Register screen component
**File(s):** `client/src/lib/Register.svelte`
**Action:** create
**Description:** First-launch form collecting server URL (prefilled from the store), invite token, username, password (AC#2). Reuses `.card`/`.row`/`label`/`input`/`button`/`.ok`/`.err` from `app.css` (no scoped styles needed). Uses runes only: `$state` fields, a `"idle" | "submitting" | "error"` submit status, `bind:value`, `onclick`/form `onsubmit`. Client-side pre-check: password length ≥ 8 (mirrors the server schema, research Decision 7) before the round-trip. On submit it persists the server URL via `store.setServerUrl(...)`, calls `auth.register(...)`, and on success `setSession(body.session)` + `store.applySession(body)`, then notifies the parent to switch to `app`. Exposes a callback prop (Svelte 5 `$props()`) like `onAuthed: () => void` and `onShowLogin: () => void` so `App.svelte` owns the view switch.
**Diff shape:**
- Add `let { onAuthed, onShowLogin } = $props<{ onAuthed: () => void; onShowLogin: () => void }>()`.
- Add `$state` fields: `serverUrl` (seeded from `store.serverUrl`), `token`, `username`, `password`, `status`, `errorMsg`.
- Add `async function submit()` — validate password length → `store.setServerUrl(serverUrl)` → `auth.register(...)` → on `ok` `setSession` + `applySession` + `onAuthed()`; on `!ok` set `status="error"` + mapped `errorMsg`.
- Add markup: title, four labelled inputs, submit button (disabled while submitting), `{#if status === "error"}<p class="err">{errorMsg}</p>{/if}`, and an "Already have an account? Log in" link calling `onShowLogin`.

### Step 6: Build the Login screen component
**File(s):** `client/src/lib/Login.svelte`
**Action:** create
**Description:** Returning-user form collecting username + password, with the server URL remembered (prefilled from the store) and an optional "change server" toggle to edit it (AC#3). Same runes/style conventions as Register. On submit it persists the (possibly edited) server URL, calls `auth.login(...)`, and on success `setSession` + `applySession` + `onAuthed()`. Surfaces the uniform `invalid_credentials` message (covers wrong password, unknown user, and disabled account — research/contract) plus rate-limit and network errors.
**Diff shape:**
- Add `let { onAuthed, onShowRegister } = $props<{ onAuthed: () => void; onShowRegister: () => void }>()`.
- Add `$state` fields: `serverUrl` (seeded from `store.serverUrl`), `editServer` (toggle, default false), `username`, `password`, `status`, `errorMsg`.
- Add `async function submit()` — `store.setServerUrl(serverUrl)` → `auth.login(...)` → on `ok` `setSession` + `applySession` + `onAuthed()`; on `!ok` set mapped `errorMsg`.
- Add markup: title, server URL display + "change server" toggle, username/password inputs, submit button, error `<p class="err">`, and a "Have an invite token? Register" link calling `onShowRegister`.

### Step 7: Rewrite App.svelte as the root view switch + launch bootstrap
**File(s):** `client/src/App.svelte`
**Action:** modify
**Description:** Replace the entire M0 ping screen with the top-level view switch (research Decision 5; AC#6). A `$state<View>` union (`"loading" | "register" | "login" | "app"`) drives `{#if}` rendering. On mount, an async bootstrap runs (AC#1): seed the store's server URL (already done at module init), `getSession()` → if a token exists call `auth.validateSession(store.serverUrl, token)`; on `ok` `store.applySession(rotatedBody)` + `setSession(rotatedBody.session)` (refresh rotates the token, so the new one must be re-stored) + view `app`; on `unauthorized` `deleteSession()` + `store.clear()` + view `login` (stale token); on `network` with a stored token, also fall back to `login` so the user can retry/re-auth. With no stored token → view `login` (returning-user default, with a register affordance per research Decision 6). Renders `<Register>` / `<Login>` passing the `onAuthed`/`onShow*` callbacks (which set the view), and a minimal authed placeholder for `app` (user greeting + Logout) — the real presence UI is story 007, out of scope.
**Diff shape:**
- Remove the `Status` type, `serverUrl`/`status`/`detail` `$state`, and `checkServer()` plus the entire ping `<section>` markup.
- Add imports: `Register`, `Login`, `store` (authStore), `getSession`/`deleteSession`/`setSession` from `./lib/session`, `validateSession`/`logout` from `./lib/auth`.
- Add `type View = "loading" | "register" | "login" | "app"` and `let view = $state<View>("loading")`.
- Add an `onMount`/`$effect`-driven `bootstrap()` async function implementing the launch logic above.
- Add `async function handleLogout()` — `await logout(store.serverUrl, store.sessionToken ?? "")` (best-effort) → `deleteSession()` → `store.clear()` → `view = "login"`.
- Add markup: `{#if view === "loading"}` spinner/text `{:else if view === "register"}<Register .../>{:else if view === "login"}<Login .../>{:else}` authed placeholder with `store.currentUser?.username` and a Logout button.

### Step 8: Write the deliverable contract for story 007
**File(s):** `context/features/m1-auth-ws-presence/story-006-client-auth-screens/contracts/client-session.md`
**Action:** create
**Description:** Document the `authStore.svelte.ts` shape (reactive `currentUser`, `sessionToken`, `serverUrl`, `expiresAt`, derived `isAuthed`; `applySession`/`setServerUrl`/`clear`) and how story 007 consumes it (reads `sessionToken` to authenticate the WS connect, `serverUrl` to derive the `ws(s)://` URL, `currentUser` to highlight self; on an auth-failure WS close calls `clear()` + `deleteSession()` and the view falls back to login). Satisfies AC#7 and matches the `provides_contract: contracts/client-session.md` frontmatter.
**Diff shape:**
- Add a `#contract` markdown file with the import path (`./lib/authStore.svelte` — note bundler resolution, no extension on `.svelte.ts`? imports of `authStore.svelte.ts` are written as `from "./lib/authStore.svelte"`), the reactive field table, the mutator signatures, and the story-007 consumption notes.

## New Types / Schemas / Contracts

**`client/src/lib/types.ts`**
```ts
export interface PublicUser {
  id: number;
  username: string;
  displayName: string | null;
  createdAt: number;
}
export interface SessionResponse {
  session: string;     // raw opaque token (Bearer + WS connect credential)
  expiresAt: number;   // epoch ms
  user: PublicUser;
}
```

**`client/src/lib/auth.ts` signatures**
```ts
export type AuthErrorCode =
  | "invalid_token" | "username_taken" | "invalid_credentials"
  | "bad_request" | "rate_limited" | "unauthorized" | "network" | "unknown";
export type AuthResult =
  | { ok: true; data: SessionResponse }
  | { ok: false; error: AuthErrorCode };

export function register(args: { serverUrl: string; token: string; username: string; password: string }): Promise<AuthResult>;
export function login(args: { serverUrl: string; username: string; password: string }): Promise<AuthResult>;
export function logout(serverUrl: string, token: string): Promise<void>;        // best-effort
export function validateSession(serverUrl: string, token: string): Promise<AuthResult>; // POST /api/refresh
```

**`client/src/lib/authStore.svelte.ts` shape (the documented contract)**
```ts
// reactive (runes) — read via the exported singleton's getters
currentUser:  PublicUser | null
sessionToken: string | null
serverUrl:    string            // seeded from getStoredServerUrl()
expiresAt:    number | null
isAuthed:     boolean           // derived: sessionToken !== null && currentUser !== null
applySession(body: SessionResponse): void   // after register/login/refresh
setServerUrl(url: string): void             // mutate + persist to localStorage
clear(): void                               // wipe user/token/expiresAt (keep serverUrl)
```

**Root view union (`App.svelte`)**
```ts
type View = "loading" | "register" | "login" | "app";
```

## Configuration / Environment Changes

- **localStorage key `dc:serverUrl`** — persists the chosen server URL across relaunches (AC#4). Seeded from `DEFAULT_SERVER_URL` on first run; managed only via `getStoredServerUrl`/`setStoredServerUrl` in `config.ts`.
- **No new npm dependencies** (research Decision 8) — everything uses existing `@tauri-apps/api` (via `session.ts`), `fetch`, `localStorage`, and Svelte 5 runes. `client/package.json` and `tsconfig.json` are unchanged.

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| REST (consume) | `POST /api/register` | `{ token, username, password }` | `201` `SessionResponse` | via `auth.register`; `400`→`bad_request`, `400 invalid_token`→`invalid_token`, `409`→`username_taken`, `429`→`rate_limited` |
| REST (consume) | `POST /api/login` | `{ username, password }` | `200` `SessionResponse` | via `auth.login`; `401`→`invalid_credentials` (uniform), `400`→`bad_request`, `429`→`rate_limited` |
| REST (consume) | `POST /api/logout` | none (Bearer) | `204` | via `auth.logout`; best-effort, errors swallowed |
| REST (consume) | `POST /api/refresh` | none (Bearer) | `200` `SessionResponse` (rotated) | via `auth.validateSession` at launch; rotates token → must re-`setSession` the new one; `401`→`unauthorized` |
| Keychain (consume) | `getSession`/`setSession`/`deleteSession` | token string / none | `string \| null` / void | story-005 wrapper; never call `invoke` directly; `null`/no-op in plain browser |
| Store (provide) | `applySession`/`setServerUrl`/`clear` + reactive fields | see shape above | — | documented in `contracts/client-session.md` for story 007 |
| Component (provide) | `Register`, `Login` props | `onAuthed`, `onShowLogin`/`onShowRegister` callbacks | — | parent `App.svelte` owns view switching |

**Error-mapping table (status/body → `AuthErrorCode`)**

| HTTP | body `error` | maps to | UI message (example) |
| ---- | ------------ | ------- | -------------------- |
| network throw | — | `network` | "Could not reach the server." |
| 400 | `Bad Request` | `bad_request` | "Check your input (password must be at least 8 characters)." |
| 400 | `invalid_token` | `invalid_token` | "Invite token is invalid, used, or revoked." |
| 401 | `invalid_credentials` | `invalid_credentials` | "Incorrect username or password." |
| 401 | `unauthorized` | `unauthorized` | (launch only — silently fall back to login) |
| 409 | `username_taken` | `username_taken` | "That username is already taken." |
| 429 | (any) | `rate_limited` | "Too many attempts — try again shortly." |
| other | — | `unknown` | "Something went wrong (HTTP <status>)." |

## Edge Cases & Gotchas

- **Refresh rotates the token** — `validateSession` returns a NEW `session`; on success the launch path MUST `setSession(newToken)` (not the old one) or the next relaunch validates a dead token. Handled in Step 7.
- **Stale stored token** — `401` from refresh → `deleteSession()` + `store.clear()` + show login (feature edge case "relaunch with expired session"). Handled in Step 7.
- **Network failure at launch with a stored token** — don't strand on `loading`; fall back to `login` (token kept in keychain, user can retry once server is reachable). Handled in Step 7.
- **Plain-browser dev** — `getSession()` always returns `null`, so launch always lands on `login`; auth still type-checks and runs (story-005 degradation). No special handling needed.
- **localStorage unavailable / throws** — `getStoredServerUrl`/`setStoredServerUrl` wrap access in try/catch, degrading to `DEFAULT_SERVER_URL`. Handled in Step 2.
- **Uniform 401 on login** — wrong password, unknown user, AND disabled account all map to one `invalid_credentials` message (no enumeration; AC#5 "disabled account" covered without a distinct message). Handled in Steps 3/6.
- **Client password pre-check** — block submit when password < 8 with a friendly message, but still handle the server's `400 Bad Request` defensively. Handled in Steps 3/5.
- **`.svelte.ts` is mandatory** for the store because `$state`/`$derived` run outside a component; importing it elsewhere is written as `from "./lib/authStore.svelte"` (bundler resolution, no `.ts`/`.js` suffix). Gotcha in Steps 4/8.
- **No `.js` import suffixes on the client** — `moduleResolution: "bundler"`; imports omit extensions (`from "./lib/auth"`), unlike the server. Applies to all new modules.
- **Logout is best-effort** — server revoke may fail (network), but the keychain + store are cleared unconditionally so the user always reaches login. Handled in Step 7.
- **Empty/whitespace fields** — disable the submit button until required fields are non-empty (and trim the server URL) to avoid sending obviously-bad requests. Handled in Steps 5/6.

## Acceptance Criteria Checklist

- [ ] On launch reads stored session and validates (refresh) → app or auth screens → Steps 7, 3 (validateSession)
- [ ] Register collects serverUrl/token/username/password → `POST /api/register` → stores session → proceeds → Steps 5, 3, 1
- [ ] Login collects username+password (server URL remembered) → `POST /api/login` → stores session; Logout clears keychain + returns to login → Steps 6, 7
- [ ] Server URL persisted (replaces M0 `DEFAULT_SERVER_URL`-only flow) → Steps 2, 4
- [ ] Error states surfaced (invalid/used token, duplicate username, wrong credentials, disabled account, network) → Steps 3, 5, 6 (error-mapping table)
- [ ] Built with Svelte 5 runes; ping screen replaced with a view switch; `npm run typecheck` passes → Steps 7, 5, 6, 4
- [ ] `contracts/client-session.md` documents the auth/session store shape for story 007 → Step 8
