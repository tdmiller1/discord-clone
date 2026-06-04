#plan

# Plan: Client — gateway connection & live presence list

## Summary
Add a runes `gateway.svelte.ts` module that owns the WebSocket lifecycle (connect/identify/reconnect/teardown) and a reactive presence `Map<number, Member>`, plus a `Presence.svelte` component rendered in `App.svelte`'s `"app"` view that shows the member list with live online/offline dots and routes a `4001` auth-failure close back to login. Frame shapes are mirrored into `client/src/lib/types.ts`.

## Implementation Steps

### Step 1: Extend client frame/contract types
**File(s):** `client/src/lib/types.ts`
**Action:** modify
**Description:** Add the gateway shapes mirrored from `server/src/types.ts` and the story-004 WS contract: `PresenceStatus`, `Member` (extends existing `PublicUser`), `ReadyPayload`, `PresenceUpdatePayload`, the generic `Envelope`, and a discriminated `ServerFrame` union over `op` so the gateway can `switch (frame.op)` with exhaustive typing. Keep `channels` as `unknown[]` (ignored in M1) and `voiceChannelId: number | null` (ignored in M1) to match the contract exactly.
**Diff shape:**
- Add `export type PresenceStatus = "online" | "offline";`
- Add `export interface Member extends PublicUser { status: PresenceStatus; voiceChannelId: number | null; }`
- Add `export interface ReadyPayload { user: PublicUser; channels: unknown[]; members: Member[]; }`
- Add `export interface PresenceUpdatePayload { userId: number; status: PresenceStatus; voiceChannelId: number | null; }`
- Add `export interface Envelope<Op extends string = string, D = unknown> { op: Op; d: D; }`
- Add `export type ServerFrame = Envelope<"ready", ReadyPayload> | Envelope<"presence.update", PresenceUpdatePayload>;`

### Step 2: Create the gateway runes module (socket + presence state)
**File(s):** `client/src/lib/gateway.svelte.ts`
**Action:** create
**Description:** A `*.svelte.ts` singleton (mirrors `authStore.svelte.ts`) that owns the WebSocket and the reactive presence state, so the socket survives component re-renders, has one teardown point, and keeps `App`/`Presence` thin. It reads `store.serverUrl`/`store.sessionToken`/`store.currentUser` from `authStore.svelte` and exposes reactive getters plus `connect()`/`disconnect()`. It does NOT touch the keychain or the view — auth-failure is surfaced as a one-shot reactive flag that `App` reacts to (the keychain/session-clear + view switch stay co-located in `App`, matching where `bootstrap`/`handleLogout` already live).

Module internals:
- Module-level `let _members = $state(new Map<number, Member>())`, `let _status = $state<ConnStatus>("closed")`, `let _authFailed = $state(false)`.
- `const _memberList = $derived(...)` — sorts the map values online-first then by `username` (locale, case-insensitive) for a stable display order.
- Non-reactive module locals (NOT `$state`): `socket: WebSocket | null`, `intentional: boolean`, `reconnectTimer: ReturnType<typeof setTimeout> | null`, `backoffMs: number`.
- `wsUrl()` helper: `new URL(store.serverUrl)`; `u.protocol = u.protocol === "https:" ? "wss:" : "ws:"`; `u.pathname = "/ws"`; `return u.toString()`.
- `open()` (internal): guard on `store.sessionToken === null` (set `_status="closed"`, return); set `_status` to `"connecting"` (or `"reconnecting"` when a backoff is pending); `socket = new WebSocket(wsUrl())`; wire `onopen`/`onmessage`/`onclose`/`onerror`.
  - `onopen`: read `store.sessionToken` at send time, guard non-null, `socket.send(JSON.stringify({ op: "identify", d: { token } }))`. (Do NOT set `_status="open"` here — wait for `ready`, since a bad token closes with `4001` before any frame.)
  - `onmessage`: `JSON.parse` inside try/catch (ignore parse errors); validate it's an object with a string `op`; `switch (frame.op)` → `"ready"` seeds the members map (reassign a fresh `Map` from `d.members` keyed by `id`), set `_status="open"`, reset `backoffMs`; `"presence.update"` mutates the matching `userId`'s `status` (see Step 2 reactivity note); default → ignore.
  - `onclose`: if `intentional` → leave `_status="closed"`, return. If `event.code === 4001` → set `_authFailed=true`, `_status="closed"`, do NOT reconnect (App handles clear + view). Otherwise → `_status="reconnecting"`, `scheduleReconnect()`.
  - `onerror`: no-op (the following `onclose` drives reconnect).
- `scheduleReconnect()`: if `intentional` or `store.sessionToken === null`, return; clear any existing timer; `reconnectTimer = setTimeout(open, jittered backoff)`; then `backoffMs = min(backoffMs * 2, BACKOFF_MAX_MS)`.
- Exported `gateway` object: getters `members` (→ `_memberList`), `status`, `authFailed`; methods `connect()` (set `intentional=false`, reset `backoffMs=BACKOFF_BASE_MS`, `open()`), `disconnect()` (set `intentional=true`, clear `reconnectTimer`, reset members map + `_status="closed"`, `socket?.close(1000)` then `socket=null`), and `clearAuthFailed()` (reset `_authFailed=false`, called by App after it routes to login so a later reconnect starts clean).

**Diff shape:**
- Add new file with the singleton described above; bundler imports (NO `.ts`/`.js` suffix), e.g. `import { store } from "./authStore.svelte";`, `import type { Member, ServerFrame } from "./types";`.

> Reactivity note for `presence.update`: Svelte 5 does not deep-track `Map` entries. Apply updates by replacing the entry and reassigning the map: read the existing `Member`, `_members.set(userId, { ...existing, status })`, then `_members = new Map(_members)` to trigger the `$derived` recompute. Ignore updates for a `userId` not present in the map.

### Step 3: Create the Presence (member-list) component
**File(s):** `client/src/lib/Presence.svelte`
**Action:** create
**Description:** The component rendered in the `"app"` view. Mirrors `Login.svelte`/`Register.svelte` structure (`<script lang="ts">`, `$props`, `$derived`, scoped `<style>` reusing global tokens/classes). It owns the connection lifecycle wiring via `onMount`/`onDestroy`, renders the header (signed-in-as + Log out, moved from `App`'s placeholder), a connection-status line, and the member list with status dots; self is highlighted via `store.currentUser?.id`.

Internals:
- `let { onLogout, onSessionInvalid } = $props<{ onLogout: () => void; onSessionInvalid: () => void; }>();`
- `import { gateway } from "./gateway.svelte"; import { store } from "./authStore.svelte"; import { onMount, onDestroy } from "svelte";`
- `onMount(() => gateway.connect());` and `onDestroy(() => gateway.disconnect());`.
- `$effect(() => { if (gateway.authFailed) onSessionInvalid(); });` — when the gateway flags a `4001`, tell `App` (which clears session + switches view). (Alternative: surface the flag to `App` directly and `$effect` there; component-local `$effect` keeps `Presence` self-contained and matches the callback-prop convention.)
- `const selfId = $derived(store.currentUser?.id ?? null);`
- A `statusLabel` derived from `gateway.status` for the connection line ("Connecting…", "Reconnecting…", "Connected"; "closed" → blank/hidden).
- Markup: `<main>` → `<h1>` + tagline `Signed in as {store.currentUser?.username ?? "user"}` + Log out button calling `onLogout`; a `.status` line driven by `gateway.status`; a `.card` listing `{#each gateway.members as m (m.id)}` rows: a status dot (`.dot` + `.online`/`.offline`), the username (with a "(you)" suffix when `m.id === selfId`), and an optional offline/online text.
- Scoped `<style>`: only the member-row + status-dot specifics; `.dot.online { background: var(--ok); }`, `.dot.offline { background: var(--muted); }`, plus row layout. Everything else uses global `.card`/`.row`/`.tagline`/`button`/`--muted`.

**Diff shape:**
- Add new component file as above.

### Step 4: Wire Presence into App's "app" view + auth-failure routing
**File(s):** `client/src/App.svelte`
**Action:** modify
**Description:** Replace the placeholder `"app"` branch body (the inline "Channels and presence arrive…" card and its Log out button) with `<Presence ... />`. Pass `onLogout={handleLogout}` (existing handler already does best-effort `POST /api/logout` + `deleteSession()` + `store.clear()` + `view="login"`) and `onSessionInvalid` (a new handler that does the auth-failure cleanup: `gateway.clearAuthFailed()` → `deleteSession()` → `store.clear()` → `view="login"`, matching the client-session contract step 5; no logout POST since the session is already dead server-side).
**Diff shape:**
- Add `import Presence from "./lib/Presence.svelte";` and `import { gateway } from "./lib/gateway.svelte";`.
- Add `async function handleSessionInvalid(): Promise<void> { gateway.clearAuthFailed(); await deleteSession(); store.clear(); view = "login"; }`.
- Change the `{:else}` (`"app"`) block: remove the inline placeholder `<main>`; render `<Presence onLogout={handleLogout} onSessionInvalid={handleSessionInvalid} />`.
- Remove the now-unused `.muted` scoped style (moved into `Presence`) if nothing else uses it.

> Note: `handleLogout` calls `gateway.disconnect()` implicitly via `Presence`'s `onDestroy` when `view` flips away from `"app"` and the component unmounts. To be explicit and avoid a teardown race, also call `gateway.disconnect()` at the top of `handleLogout` (idempotent — `disconnect()` sets `intentional` and is safe to call twice).

## New Types / Schemas / Contracts

In `client/src/lib/types.ts` (mirrors `server/src/types.ts` + the story-004 contract):

```ts
export type PresenceStatus = "online" | "offline";

export interface Member extends PublicUser {
  status: PresenceStatus;
  voiceChannelId: number | null; // always null in M1
}

export interface ReadyPayload {
  user: PublicUser;
  channels: unknown[]; // always [] in M1 (ignored)
  members: Member[];
}

export interface PresenceUpdatePayload {
  userId: number;
  status: PresenceStatus;
  voiceChannelId: number | null; // always null in M1
}

export interface Envelope<Op extends string = string, D = unknown> {
  op: Op;
  d: D;
}

export type ServerFrame =
  | Envelope<"ready", ReadyPayload>
  | Envelope<"presence.update", PresenceUpdatePayload>;
```

Gateway store (`client/src/lib/gateway.svelte.ts`):

```ts
type ConnStatus = "connecting" | "open" | "reconnecting" | "closed";

export const gateway: {
  // reactive getters
  get members(): Member[];      // derived, sorted: online-first then username
  get status(): ConnStatus;     // for the connection-status line
  get authFailed(): boolean;    // one-shot 4001 signal for App

  // methods
  connect(): void;              // intentional=false, reset backoff, open socket
  disconnect(): void;           // intentional=true, clear timer, reset members, close(1000)
  clearAuthFailed(): void;      // App calls after routing to login
};
```

Constants (tuning, internal to the module):
- `BACKOFF_BASE_MS = 1000`
- `BACKOFF_MAX_MS = 30000`
- jitter: `delay = backoffMs * (0.5 + Math.random() * 0.5)` (randomized 50–100% of the current backoff)

`Presence.svelte` props: `{ onLogout: () => void; onSessionInvalid: () => void }`.

## Configuration / Environment Changes

None. No new env vars, deps, or localStorage keys. The WS URL is derived at runtime from the existing `store.serverUrl` (`dc:serverUrl`) via the `http→ws` / `https→wss` swap + `/ws` path — that is logic, not config. Reconnect backoff constants live as module constants, not config.

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| WS (client→server) | `identify` | `{ op: "identify", d: { token: store.sessionToken } }` sent on `onopen` | — | First and only frame the client sends in M1; raw session token, no header/query (browsers can't set WS headers). |
| WS (server→client) | `ready` | — | `{ op, d: ReadyPayload }` | Parsed once after a valid identify; seeds the members map. `d.channels` ignored. |
| WS (server→client) | `presence.update` | — | `{ op, d: PresenceUpdatePayload }` | Mutates the matching `userId`'s status live. `d.voiceChannelId` ignored. |
| WS close | `4001` | — | close event | Auth failure (invalid/expired/revoked/disabled, missed deadline, mid-session revocation) → clear session + return to login; no reconnect. |
| WS close | other (`1006`, server restart, net drop) | — | close event | While authed and not intentional → reconnect with capped exponential backoff. |
| Module | `gateway` (new) | `connect()` / `disconnect()` / `clearAuthFailed()` | reactive `members` / `status` / `authFailed` | Singleton runes store; `client/src/lib/gateway.svelte.ts`. |
| Component | `Presence` (new) | props `onLogout`, `onSessionInvalid` | rendered member list | Replaces the `App` `"app"` placeholder. |

## Edge Cases & Gotchas

- `presence.update` for an unknown `userId` (not in the map) — ignored safely (no insert); shouldn't happen since `ready` lists all non-disabled users. — Step 2 (`onmessage`).
- Malformed/non-JSON frame, non-object frame, or missing string `op` — `JSON.parse` in try/catch + a shape guard; ignored, never throws. — Step 2.
- Unknown `op` (e.g. future `voice.*`/`message.*`) — `switch` default ignores. — Step 2.
- `store.sessionToken === null` at connect or send time — `open()` and `onopen` both guard; no socket / no send. — Step 2.
- Intentional close (logout / unmount) must NOT reconnect — `intentional` flag set in `disconnect()`, checked in `onclose` and `scheduleReconnect()`; pending `reconnectTimer` is cleared. — Steps 2, 4.
- Double `disconnect()` (explicit in `handleLogout` + `onDestroy`) — idempotent; safe. — Step 4.
- Backoff must reset on a successful (re)connect so a later drop starts at 1s again — reset `backoffMs` on `ready` and in `connect()`. — Step 2.
- Svelte 5 `Map` is not deeply reactive — reassign the map after `set()` so `$derived(members)` recomputes; reseed with a fresh `Map` on `ready`. — Step 2.
- Self appears in `ready.members` as `online` already (server registers the socket before building `ready`) — no manual self-insertion; only highlight via `store.currentUser?.id`. — Steps 2, 3.
- `_status` set to `"open"` on `ready`, not `onopen` — a dead token closes with `4001` before any frame, so "open" should mean authenticated. — Step 2.
- Heartbeat ping/pong is answered by the browser WebSocket automatically — no client app code. — (no step needed; documented.)
- The `4001` one-shot flag must be cleared after App routes to login (`clearAuthFailed()`) so a fresh login + reconnect doesn't immediately re-trip the `$effect`. — Steps 2, 4.

## Acceptance Criteria Checklist

- [ ] After login, the client opens the WS and authenticates with the stored token per the handshake → Steps 2 (`open`/`onopen` identify), 3 (`onMount` connect).
- [ ] On `ready`, renders the member list with online/offline indicators incl. the current user → Steps 2 (`ready` seeds map), 3 (rows + dots + self-highlight).
- [ ] On `presence.update`, updates the member's status live without reload → Step 2 (`onmessage` map mutation + reassign) → reactive re-render in Step 3.
- [ ] Connection lifecycle: auto-reconnect with backoff on drop; auth-failure close clears session and returns to login → Steps 2 (`onclose` 4001 vs reconnect, `scheduleReconnect`), 4 (`handleSessionInvalid`).
- [ ] Frames parsed/sent as `{ op, d }` envelopes → Steps 1 (`Envelope`/`ServerFrame`), 2 (parse + identify send).
- [ ] Svelte 5 runes; `npm run typecheck` passes; end-to-end: two clients each see the other flip online/offline live → Steps 2–4 (all runes; `ServerFrame` gives a typed exhaustive switch); manual two-client check per SPEC §14.
