#plan

# Plan: WebSocket gateway & presence

## Summary
Add a `GET /ws` gateway (via `@fastify/websocket` v11) that authenticates on the first `identify` frame by reusing the exported `authenticateSession(db, rawToken)`, sends a `ready` snapshot (user + empty channels + member list with online/offline status), and broadcasts `presence.update` on first-online / last-offline transitions. An in-memory `Map<userId, Set<socket>>` registry plus a single heartbeat interval handle dead-socket detection and double as the revocation reaper (re-validating each connection's session each tick).

## Implementation Steps

### Step 1: Add the WebSocket dependency
**File(s):** `server/package.json`
**Action:** modify
**Description:** Add `@fastify/websocket` (the Fastify-5-compatible plugin; pulls in `ws@^8` and its types transitively). Confirmed at plan time: latest is `11.2.0`, peer `fastify ^5` (installed: 5.8.5), bundles `ws ^8.16`. No bare `ws` entry is needed — its `WebSocket` type is re-exported from `@fastify/websocket`.
**Diff shape:**
- Add `"@fastify/websocket": "^11.2.0"` to `dependencies` (alphabetical, after `@fastify/rate-limit`).
- Run `npm install --prefix server` so `package-lock.json` updates and the types resolve for `npm run typecheck`.

### Step 2: Add the gateway constants & payload types
**File(s):** `server/src/types.ts`
**Action:** modify
**Description:** Add the realtime envelope and presence/ready payload shapes. Reuse `PublicUser` for the user field; a `Member` extends it with `status` + `voiceChannelId`. These are the contract shapes the gateway sends and story 007 consumes. (Per research Decision 7, the heartbeat interval and max-frame-size stay as hardcoded constants in the gateway module, NOT in `types.ts` or `config.ts`.)
**Diff shape:**
- Add `export type PresenceStatus = "online" | "offline";`
- Add `export interface Member extends PublicUser { status: PresenceStatus; voiceChannelId: number | null; }`
- Add `export interface ReadyPayload { user: PublicUser; channels: never[]; members: Member[]; }` (empty `channels` placeholder until M2).
- Add `export interface PresenceUpdatePayload { userId: number; status: PresenceStatus; voiceChannelId: number | null; }`
- Add `export interface IdentifyPayload { token: string; }` (the one inbound op M1 introduces).
- Add a generic envelope `export interface Envelope<Op extends string = string, D = unknown> { op: Op; d: D; }` and, optionally, server/client discriminated unions (`ServerEvent`, `ClientCommand`) — see "New Types".

### Step 3: Create the in-memory presence registry
**File(s):** `server/src/ws/presence.ts`
**Action:** create
**Description:** A framework-agnostic `PresenceRegistry` over a `Map<number, Set<WebSocket>>`. Keeps the route plugin thin/testable. `add` returns whether the user just came online (Set was empty before); `remove` returns whether the user just went offline (Set became empty / emptied). `broadcast` serializes an envelope once and `send`s it to every tracked socket whose `readyState === OPEN` (skipping a caller-supplied `except` socket so a joiner does not receive its own `presence.update`). `isOnline(userId)`, `onlineUserIds()` feed `ready.members`. `socketsOf(userId)` / `closeUser(userId, code, reason)` drop a revoked user's sockets. Import `WebSocket` type from `@fastify/websocket`.
**Diff shape:**
- Add `export class PresenceRegistry { ... }` with `add(userId, socket): { firstOnline: boolean }`, `remove(userId, socket): { lastOffline: boolean }`, `isOnline(userId): boolean`, `onlineUserIds(): Set<number>`, `broadcast(env: Envelope, except?: WebSocket): void`, `closeUser(userId, code, reason): void`, and a private `#map = new Map<number, Set<WebSocket>>()`.
- `add`: `const had = this.#map.get(userId); const firstOnline = !had || had.size === 0; (had ?? newSet).add(socket); return { firstOnline };`
- `remove`: delete socket from the Set; if Set now empty, delete the key and return `{ lastOffline: true }`, else `{ lastOffline: false }`. Tolerate unknown user/socket (idempotent — `remove` may fire on both `close` and `error`).

### Step 4: Create the gateway plugin (auth handshake, ready, presence, inbound handling, heartbeat)
**File(s):** `server/src/ws/gateway.ts`
**Action:** create
**Description:** `FastifyPluginAsync<WsGatewayOptions>` mirroring `routes/auth.ts`. Registers `@fastify/websocket` (with `options.maxPayload = WS_MAX_FRAME_BYTES`) and then `GET /ws` with `{ websocket: true }`. Owns the per-instance `PresenceRegistry`, a `WeakMap`/per-socket state record (`userId`, stored raw token, `isAlive`, `authed`, the auth-deadline timer), and the single heartbeat interval. Cleared in `app.addHook("onClose", ...)`.

Handshake / lifecycle per connection:
1. On connect (handler entry), the socket is **unauthenticated**. Start an auth-deadline timer (`WS_AUTH_DEADLINE_MS`); if it fires before a valid `identify`, `socket.close(WS_CLOSE_UNAUTHORIZED, "unauthorized")`.
2. `socket.on("message", ...)`:
   - Guard payload length defensively (`data.length > WS_MAX_FRAME_BYTES` → `close(WS_CLOSE_TOO_LARGE)`) in case `maxPayload` is ever bypassed; `ws` itself also auto-closes oversize frames with `1009`.
   - `JSON.parse` inside try/catch; malformed → ignore (return), do not throw/crash.
   - Require an object with a string `op`; else ignore.
   - If **not yet authed**: only `op === "identify"` is honored. Read `d.token` (string); call `authenticateSession(app.db, token)`. `null` → `close(WS_CLOSE_UNAUTHORIZED)` and never send `ready`. Non-null → clear the deadline timer; mark authed; store `userId = result.user.id` and the raw `token` on the per-socket state (needed by the heartbeat reaper); build & send `ready` (Step 5 / below); `const { firstOnline } = registry.add(userId, socket)`; if `firstOnline`, `registry.broadcast({ op: "presence.update", d: { userId, status: "online", voiceChannelId: null } }, socket)`. Any non-`identify` op before auth → ignore (deadline still governs).
   - If **already authed**: M1 defines no client→server ops in scope, so any/unknown op (including a second `identify`) is ignored safely — no throw.
3. `socket.on("pong", () => { state.isAlive = true; })`.
4. `socket.on("close")` and `socket.on("error")` → a single `teardown()` (idempotent): clear the deadline timer; if authed, `const { lastOffline } = registry.remove(userId, socket)`; if `lastOffline`, broadcast `presence.update {status:"offline"}`. Guard against double-run (both `close` and `error` can fire).

Building `ready` (inline helper): `members = db.prepare("SELECT * FROM users WHERE disabled = 0").all()` → `toPublicUser(row)` spread into `{ ...pub, status: registry.isOnline(row.id) ? "online" : "offline", voiceChannelId: null }`. Note ordering: register the joining socket AFTER computing `members` would omit self-online; instead compute `members` with the current registry, then add — OR add first then build (so the connecting user shows "online" in their own `ready`). **Chosen: add to registry first, then build `members`, then send `ready`, then broadcast `presence.update` to others** — so the new client sees itself online in `ready` and the `firstOnline` flag is captured from the `add` return.

Heartbeat (Step 6) lives here as one `setInterval(WS_HEARTBEAT_MS)`.
**Diff shape:**
- Add module-level constants: `WS_PATH = "/ws"`, `WS_MAX_FRAME_BYTES = 64 * 1024`, `WS_HEARTBEAT_MS = 30_000`, `WS_AUTH_DEADLINE_MS = 10_000`, `WS_CLOSE_UNAUTHORIZED = 4001`, `WS_CLOSE_TOO_LARGE = 1009`.
- Add `interface WsGatewayOptions { config: Config }` and `interface ConnState { userId: number | null; token: string | null; isAlive: boolean; authed: boolean; deadline: NodeJS.Timeout | null }`.
- Add `const wsGateway: FastifyPluginAsync<WsGatewayOptions> = async (app, opts) => { ... }; export default wsGateway;` containing: `await app.register(websocket, { options: { maxPayload: WS_MAX_FRAME_BYTES } })`, `const registry = new PresenceRegistry()`, a `Set<WebSocket>` (or `Map<WebSocket, ConnState>`) of live sockets for the heartbeat sweep, the route, the heartbeat interval, and `app.addHook("onClose", ...)` clearing the interval + closing all sockets.

### Step 5: Heartbeat + revocation reaper (within the gateway plugin)
**File(s):** `server/src/ws/gateway.ts`
**Action:** modify (same file as Step 4 — listed separately for clarity)
**Description:** One `setInterval(WS_HEARTBEAT_MS)`. Each tick iterate every live socket's `ConnState`:
- Dead-socket detection: if `state.isAlive === false` (previous ping went unanswered) → `socket.terminate()` (its `close` handler runs teardown → presence offline) and skip the rest.
- Revocation reaper: for authed sockets, re-run `authenticateSession(app.db, state.token)`. `null` (session revoked/expired or user disabled via `server revoke-user`) → `socket.close(WS_CLOSE_UNAUTHORIZED, "unauthorized")` (teardown flips presence offline within one interval). This is how CLI-side revocation — which runs in a separate process and only mutates SQLite — is detected without any IPC.
- Otherwise: `state.isAlive = false; socket.ping();`.
Clear the interval in `onClose` so the timer never keeps the process alive in tests / shutdown.
**Diff shape:**
- Add `const heartbeat = setInterval(() => { for (const [socket, state] of sockets) { ... } }, WS_HEARTBEAT_MS);`
- Add `app.addHook("onClose", async () => { clearInterval(heartbeat); for (const socket of sockets.keys()) socket.terminate(); });`

### Step 6: Register the gateway in buildApp
**File(s):** `server/src/app.ts`
**Action:** modify
**Description:** Register the gateway plugin inside `buildApp`, mirroring `void app.register(authRoutes, { config })`. No `declare module "fastify"` change is required because the registry is encapsulated in the plugin (not exposed as `app.presence`) — keeping the augmentation block untouched (research Decision 4/8). Place the registration after `authRoutes` and before the `/health` route.
**Diff shape:**
- Add `import wsGateway from "./ws/gateway.js";` at the top with the other plugin imports.
- Add `void app.register(wsGateway, { config });` after the `authRoutes` registration.

### Step 7: Write the contract document
**File(s):** `context/features/m1-auth-ws-presence/story-004-ws-gateway-presence/contracts/ws-protocol.md`
**Action:** create
**Description:** The deliverable contract (AC requires it) for story 007 (client). Documents: the `ws://host:8080/ws` endpoint; the first-frame `identify` handshake (`{ "op": "identify", "d": { "token": "<raw-session>" } }`) and the auth deadline; the auth-failure close code `4001` (single code for missing/invalid/expired/revoked/disabled and mid-session revocation — story 007 keys "clear session → return to login" on it); the `ready` payload shape (`{ user, channels: [], members }` with `Member.status`/`voiceChannelId`); the `presence.update` payload; the `{ op, d }` envelope; heartbeat (server ping every 30s, abrupt-drop → offline within one interval); the 64 KiB max frame size; and that M1 has no other client→server ops (unknown ops ignored). Mark `voice.*` / `message.*` as out of scope (M2/M4). Mirror the `#contract` heading style of `contracts/auth-api.md`.
**Diff shape:**
- Create the file with `#contract` header and sections: Endpoint, Handshake (`identify`), Close codes, `ready` payload, `presence.update`, Heartbeat, Frame limits, Out of scope.

## New Types / Schemas / Contracts

Added to `server/src/types.ts` (reusing `PublicUser`):

```ts
export type PresenceStatus = "online" | "offline";

/** A user as it appears in ready.members: PublicUser + live presence. */
export interface Member extends PublicUser {
  status: PresenceStatus;
  voiceChannelId: number | null; // always null in M1 (voice arrives M4)
}

/** Generic WS envelope (SPEC.md §7). */
export interface Envelope<Op extends string = string, D = unknown> {
  op: Op;
  d: D;
}

/** server→client: op "ready" */
export interface ReadyPayload {
  user: PublicUser;
  channels: never[]; // empty placeholder until M2
  members: Member[];
}

/** server→client: op "presence.update" */
export interface PresenceUpdatePayload {
  userId: number;
  status: PresenceStatus;
  voiceChannelId: number | null;
}

/** client→server: op "identify" (the only inbound op in M1) */
export interface IdentifyPayload {
  token: string;
}

// Optional discriminated unions for exhaustiveness at send/parse sites:
export type ServerEvent =
  | Envelope<"ready", ReadyPayload>
  | Envelope<"presence.update", PresenceUpdatePayload>;
export type ClientCommand = Envelope<"identify", IdentifyPayload>;
```

Gateway constants (in `server/src/ws/gateway.ts`, hardcoded — not env):

| Constant | Value | Meaning |
| -------- | ----- | ------- |
| `WS_PATH` | `"/ws"` | Gateway route |
| `WS_MAX_FRAME_BYTES` | `65536` (64 KiB) | Inbound frame cap (`ws` `maxPayload` + defensive guard) |
| `WS_HEARTBEAT_MS` | `30000` | Ping interval / max staleness before terminate |
| `WS_AUTH_DEADLINE_MS` | `10000` | Time to send a valid `identify` after connect |
| `WS_CLOSE_UNAUTHORIZED` | `4001` | Single auth-failure close code (private 4000–4999 range) |
| `WS_CLOSE_TOO_LARGE` | `1009` | Oversize frame (matches `ws`'s own behavior) |

## Configuration / Environment Changes

**None for config/env.** Per research Decision 7, heartbeat interval, auth deadline, max frame size, WS path, and close codes are hardcoded constants in the gateway module — `SPEC.md §12`, `server/.env.example`, and `loadConfig()` are intentionally left unchanged for M1 (no `WS_*` knobs exist in SPEC §12 today). The only dependency change is `@fastify/websocket` in `server/package.json` (Step 1).

(If a future milestone wants these tunable, the established path is `loadConfig()` + `.env.example` + `SPEC.md §12` — out of scope here.)

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| WS | `GET /ws` (upgrade) | WebSocket handshake (no auth header — browsers can't set one) | Upgraded socket, unauthenticated until `identify` | `{ websocket: true }` route; `maxPayload` 64 KiB |
| WS in | `identify` | `{ op:"identify", d:{ token } }` (first frame) | on success → `ready`; on failure → close `4001` | Only client→server op in M1; must arrive within 10s |
| WS out | `ready` | — | `{ op:"ready", d:{ user, channels:[], members } }` | Sent once, only after successful `identify` |
| WS out | `presence.update` | — | `{ op:"presence.update", d:{ userId, status, voiceChannelId:null } }` | Broadcast on first-online (to others) and last-offline (to all) |
| WS close | `4001` unauthorized | — | close frame, no `ready` | missing/invalid/expired/revoked/disabled + mid-session revocation |
| WS close | `1009` too large | — | close frame | oversize inbound frame |
| internal | `PresenceRegistry` | `server/src/ws/presence.ts` | `add/remove/isOnline/onlineUserIds/broadcast/closeUser` | in-memory `Map<userId, Set<socket>>`, no broker |
| consumed | `authenticateSession(db, raw)` | raw token from `identify` | `{ user, session } \| null` | reused verbatim from story 003 — not reimplemented |

## Edge Cases & Gotchas

- **No `Authorization` header on the WS handshake** (browser/webview can't set one) — solved by first-frame `identify` rather than a query param (keeps the raw token out of URLs/access logs). — Step 4.
- **Connect without ever identifying** — auth-deadline timer closes the socket with `4001`; no `ready`, no registry entry. — Step 4.
- **Invalid / expired / revoked / disabled on `identify`** — `authenticateSession` returns `null` → close `4001`, no `ready`. Satisfies the firm AC ("a revoked session cannot establish a new connection"). — Step 4.
- **Mid-session revocation via `server revoke-user`** (separate process, only mutates SQLite — no IPC) — the heartbeat tick re-runs `authenticateSession` per authed socket and closes `null` ones with `4001`; presence flips offline within one interval (≤30s). — Step 5.
- **Abrupt disconnect (network drop / app kill)** — heartbeat ping/pong: `isAlive=false` for a full interval → `terminate()` → `close` handler runs teardown → presence offline. Prevents stuck "online". — Step 5.
- **Multiple sockets per user** (two devices / reinstall) — `Map<userId, Set<socket>>`: online iff Set non-empty; `presence.update online` only on the FIRST socket, `offline` only on the LAST close. `add`/`remove` return the flip so it broadcasts exactly once. — Step 3.
- **`close` AND `error` both firing** — single idempotent `teardown()` guarded by a flag; `registry.remove` is also idempotent for unknown socket. — Step 4.
- **Joiner seeing its own presence** — add to registry first so `ready.members` shows self `online`; broadcast `presence.update` with the joining socket excluded (`broadcast(env, socket)`). — Steps 3, 4.
- **Malformed JSON / non-object frame / missing `op`** — swallowed (return), never throws/crashes the connection. — Step 4.
- **Unknown op post-auth** (e.g. premature `message.send`/`voice.*`) — ignored safely; M1 defines no in-scope client→server ops. — Step 4.
- **Oversize frame** — `ws` `maxPayload` auto-closes with `1009`; a defensive length check mirrors it. — Step 4.
- **Disabled users in `members`** — `ready.members` is `WHERE disabled = 0`, consistent with `authenticateSession`/login rejecting disabled accounts. — Step 4.
- **Interval keeping the process / test alive** — `clearInterval` + terminate all sockets in `app.addHook("onClose")` (mirrors the existing `db.close()` onClose). — Step 5.
- **`@fastify/websocket` v11 handler signature** — passes the raw `ws` `WebSocket` as the FIRST arg (`(socket, req)`), NOT the old `SocketStream` `{ socket }` wrapper; use `socket.on/send/ping/close/terminate` directly. Import the `WebSocket` type from `@fastify/websocket`. — Steps 3, 4.

## Acceptance Criteria Checklist

- [ ] WS endpoint authenticates on connect via story-003's validator; invalid/expired/revoked → defined close code, no `ready` → Steps 4 (`identify` + `authenticateSession`), 7
- [ ] On success sends `ready { user, channels:[], members }` with each member's online status; `channels` empty → Steps 2, 4
- [ ] Tracks connections per user; first socket broadcasts `presence.update online`, last close broadcasts `offline` → Steps 3, 4
- [ ] All frames use `{ op, d }`; inbound size-limited; unknown ops ignored safely → Steps 2, 4
- [ ] Revoked session / `server revoke-user` closes the user's sockets + flips offline; revoked session can't connect → Steps 4 (connect-time), 5 (heartbeat reaper)
- [ ] Heartbeat/ping-pong detects dead sockets so presence isn't stuck online → Step 5
- [ ] `npm run typecheck` passes; verifiable with two `wscat`/`websocat` clients seeing `ready` + `presence.update` → Steps 1 (install for types), 2, 4
- [ ] `contracts/ws-protocol.md` documents handshake, `ready`, and `presence.update` → Step 7
