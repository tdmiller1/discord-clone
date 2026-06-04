#research

# Research: Client — gateway connection & live presence list

## Files to Touch

### Likely Modified
- `client/src/App.svelte` — the `"app"` view currently renders a placeholder ("Channels and presence arrive in the next milestone."). Replace that branch's body with the presence member-list component. Also wire an auth-failure path: the gateway can close `4001` on a mid-session revocation, which must drive `App` back to `view = "login"` (mirroring the existing `handleLogout` cleanup). Plan to pass an `onAuthFailure` (or `onSessionInvalid`) callback into the presence component, or surface it via the gateway store; `App` reacts by calling `deleteSession()` + `store.clear()` + `view = "login"`.

### Likely Created
- `client/src/lib/gateway.svelte.ts` — a runes `*.svelte.ts` module that owns the WebSocket lifecycle and reactive presence state. Must be `*.svelte.ts` because it holds `$state` (the members map + connection status) outside a component (same rule as `authStore.svelte.ts`). Exposes: a reactive members list, a connection-status field, a `connect()`/`disconnect()` pair, and a way to signal auth-failure to `App`. Mirrors the singleton-`store` export pattern of `authStore.svelte.ts`. (Alternative the planner may pick: keep the socket logic inside the presence component via `$effect` + `onMount`/`onDestroy`. A dedicated module is cleaner because the socket must be torn down on logout and survive component-internal re-renders, and keeps `App.svelte` thin — recommend the module.)
- `client/src/lib/Presence.svelte` (or `MemberList.svelte`) — the component rendered in the `"app"` view: header (signed-in-as + Log out button, moved from `App.svelte`'s current placeholder), connection-status line, and the member list with online/offline dots. Mirrors `Login.svelte`/`Register.svelte` structure (`<script lang="ts">`, `$props`, `$state`, `$derived`, scoped `<style>`).
- `client/src/lib/types.ts` — extend with the gateway frame types: `Member` (`PublicUser & { status: "online" | "offline"; voiceChannelId: number | null }`), `ReadyPayload` (`{ user: PublicUser; channels: unknown[]; members: Member[] }`), `PresenceUpdate` (`{ userId: number; status: "online" | "offline"; voiceChannelId: number | null }`), and a discriminated `ServerFrame` union over `op`. Today `types.ts` holds only `PublicUser` + `SessionResponse`. (Could instead live in `gateway.svelte.ts`; `types.ts` is the established home for contract shapes — recommend extending it.)

### Read-Only Reference (patterns to follow)
- `client/src/lib/authStore.svelte.ts` — THE pattern for a runes singleton: module-level `let _x = $state(...)`, a `$derived`, and an exported `store` object of getters + mutators. Copy this shape for the gateway module. Also the source for `sessionToken`, `serverUrl`, `currentUser`, `clear()`.
- `client/src/lib/Login.svelte` / `Register.svelte` — component conventions: `let { onAuthed } = $props<{...}>()` callback props, `$state` locals, `$derived` flags, scoped `<style>` reusing global tokens (`var(--muted)`, `.card`, `.row`, `.link`), no `.ts`/`.js` import suffixes.
- `client/src/lib/session.ts` — `deleteSession()` to pair with `store.clear()` on auth-failure (no-op outside Tauri, safe).
- `client/src/lib/auth.ts` — pattern for a no-runes typed module with a discriminated result type; the `new URL(path, serverUrl)` idiom is the same building block used for the ws:// derivation.
- `client/src/app.css` — global tokens: `--ok` (#23a55a green) and `--err` (#f23f43 red) already exist — use `--ok` for the online dot, `--muted` for offline. `.card`, `.row`, `.tagline`, `button` are all global; new component styles should only add what's specific (the member rows + status dots).
- `server/src/ws/gateway.ts` — the authoritative server side; confirms `WS_PATH = "/ws"`, close code `4001`, the exact `ready`/`presence.update` JSON, that the joiner sees itself `online` in `ready.members`, and that a second `identify` / unknown ops are ignored.
- `server/src/types.ts` — server-side `Member` / `ReadyPayload` definitions to mirror in the client `types.ts`.

## Existing Patterns

- **Runes outside components:** state that must live in a module uses a `*.svelte.ts` file with module-level `let _x = $state(...)` / `$derived(...)` and an exported plain object of getters (and mutator methods). `authStore.svelte.ts` is the template. The gateway module follows it exactly.
- **Component shape:** `<script lang="ts">` first; destructured `$props` with an inline generic (`$props<{ onAuthed: () => void }>()`); `$state` for local mutable UI; `$derived` for computed flags (e.g. `canSubmit`); event handlers as plain async functions; scoped `<style>` that leans on the global tokens/classes in `app.css`.
- **Import style (client):** `moduleResolution: "bundler"` → NO `.js`/`.ts` suffix on relative imports (`import { store } from "./authStore.svelte"`). This is the opposite of the server's ESM `.js`-suffix rule. The `.svelte.ts` module is imported WITHOUT the `.ts` (e.g. `"./lib/gateway.svelte"`).
- **View switching:** `App.svelte` holds `let view = $state<View>(...)` and an `{#if view === ...}` ladder; child components flip the view through callback props (`onAuthed={() => (view = "app")}`). Add the auth-failure transition to login the same way.
- **Keychain pairing:** mutating session state always pairs the store mutator with the keychain side effect — `store.applySession(...)` + `setSession(...)`, and `store.clear()` + `deleteSession()`. The auth-failure WS close must do the `clear()` + `deleteSession()` pair (per client-session contract step 5).
- **Naming:** `lib/` holds components (PascalCase `.svelte`) and modules (camelCase `.ts`, runes modules `.svelte.ts`). Result/error shapes are discriminated unions (`AuthResult`). Mirror this for frames (`ServerFrame` discriminated on `op`).

## Data Flow

1. **Guard / mount.** The `"app"` view only renders when authenticated (`App.bootstrap` set `view = "app"` only after `store.applySession`). The presence module connects when it has a `store.sessionToken`. Use `onMount` (or an `$effect`) in the presence component to call `gateway.connect()`, and `onDestroy` to `gateway.disconnect()` (also disconnect on logout before switching views).

2. **Derive the WS URL** from `store.serverUrl` (an http(s) base, default `http://localhost:8080`):
   ```ts
   const u = new URL(store.serverUrl);
   u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
   u.pathname = "/ws"; // confirmed against server gateway WS_PATH
   const wsUrl = u.toString();
   ```
   Confirmed `/ws` and the `ws→wss` mapping from both the story-004 WS contract and `server/src/ws/gateway.ts`.

3. **Open + identify.** `new WebSocket(wsUrl)`. There is NO `Authorization` header and NO token in the query (browsers can't set headers on a `WebSocket`; the server reads neither). On `socket.onopen`, send the first frame:
   ```ts
   socket.send(JSON.stringify({ op: "identify", d: { token: store.sessionToken } }));
   ```
   Server auth deadline is 10 s, so send immediately on open. (Read `store.sessionToken` at send time; guard against `null`.)

4. **`ready` → seed members.** On `socket.onmessage`, `JSON.parse` and switch on `op`. For `op === "ready"`, store `d.members` as the reactive member list (a `Member[]`, or a `Map<number, Member>` keyed by `userId` for O(1) presence updates — recommend the map; the contract's own guidance is "apply updates to the members map"). The connecting user is already present as `"online"` in `ready.members`, so no special self-insertion is needed — only highlight self via `store.currentUser?.id`. `d.channels` is always `[]` in M1 — ignore.

5. **`presence.update` → live mutation.** For `op === "presence.update"`, find the member with matching `d.userId` and set its `status` to `d.status` (`voiceChannelId` is always `null` in M1 — ignore). Because the member list is `$state`, the UI re-renders automatically; reassign/mutate in a runes-reactive way (reassign the array, or use a `$state`-backed `Map` and reassign, or use a fine-grained reactive entry). No reload. (Edge: a `presence.update` for a `userId` not in the list — shouldn't happen since `ready` lists all non-disabled users — should be ignored safely.) Unknown ops are ignored.

6. **Auth-failure close.** On `socket.onclose`, inspect `event.code`. Code `4001` (single opaque auth-failure code; also fires on mid-session revocation caught by the server's 30 s reaper) ⇒ do NOT reconnect: clear the session (`store.clear()` + `deleteSession()`) and signal `App` to return to login. This is the contract's step-5 behavior and the feature's "revoke-user kills the session" edge case.

7. **Reconnect with backoff.** Any OTHER unexpected close (network drop, server restart, code `1006`, etc.) while still authenticated ⇒ schedule a reconnect with capped exponential backoff (e.g. start ~1 s, double, cap ~30 s, optional jitter). On a successful reopen, reset the backoff. A clean intentional close from `disconnect()` (logout / component unmount) must NOT reconnect — track an `intentional`/`closing` flag and clear any pending reconnect timer in `disconnect()`. The server's own 30 s heartbeat ping/pong is answered automatically by the browser WebSocket — no client app code required (per WS contract Heartbeat section).

8. **Connection status (UI nicety, supports verification).** Expose a reactive status (`"connecting" | "open" | "reconnecting" | "closed"`) so the member list can show "Reconnecting…" — helps the end-to-end manual check.

End-to-end verification (M1 acceptance, SPEC §14): two clients log in; each sees the other's row flip online↔offline live (one client closes → the other receives `presence.update offline`; reopen → `online`). Gate: `npm run typecheck`.

## Decisions Made

1. **Dedicated `gateway.svelte.ts` runes module owns the socket + presence state**, rather than embedding socket code in the component. Rationale: matches the established `authStore.svelte.ts` singleton pattern, survives component re-renders, gives one place to tear down on logout, and keeps `App.svelte`/the component thin. The component just reads reactive fields and renders.
2. **Members stored as a `Map<number, Member>` (reactive)** keyed by `userId`, exposed to the view as a derived sorted array. Rationale: the contract explicitly frames updates as "apply to the members map by `userId`"; O(1) `presence.update` application; trivial self-highlight via `store.currentUser?.id`. Sort order recommendation: online-first then username (cosmetic — planner can decide).
3. **Distinguish close code `4001` (auth-failure, no reconnect, clear + back to login) from all other closes (reconnect with capped exponential backoff).** Rationale: directly from the story-004 WS contract close-code table and client-session contract step 5; `4001` with the dead token must never be retried.
4. **Frame types added to `client/src/lib/types.ts`** as a discriminated `ServerFrame` union (`Member`, `ReadyPayload`, `PresenceUpdate`) mirroring `server/src/types.ts`. Rationale: `types.ts` is the established home for contract-mirrored shapes; gives a typed `switch (frame.op)`.
5. **Auth-failure surfaced to `App.svelte` via a callback prop** (e.g. `onSessionInvalid`) on the presence component, which performs `deleteSession()` + `store.clear()` + `view = "login"`. Rationale: matches the existing callback-prop view-switching pattern (`onAuthed`) and keeps the keychain/session-clear logic co-located with the rest of `App`'s session handling. (Planner may instead expose an auth-failure flag on the gateway store and `$effect` on it in `App` — either is consistent; callback prop is the closer match to existing code.)
6. **Online indicator uses existing `--ok` token; offline uses `--muted`.** Rationale: both tokens already exist in `app.css`; no new global CSS needed, only a small scoped status-dot style.

## Open Questions

None — the two upstream contracts plus the implemented `server/src/ws/gateway.ts` pin down every shape, the `/ws` path, the `4001` close semantics, and the reconnect-vs-clear decision. Sort order and exact backoff constants are cosmetic/tuning choices left to the plan.
