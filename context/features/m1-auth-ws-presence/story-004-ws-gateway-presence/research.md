#research

# Research: WebSocket gateway & presence

## Files to Touch

### Likely Modified
- `server/package.json` — add a WebSocket dependency. No `ws`/`@fastify/websocket` is installed today (`dependencies` are `@fastify/cors`, `@fastify/rate-limit`, `@node-rs/argon2`, `better-sqlite3`, `fastify@^5`). Plan to add `@fastify/websocket` (the Fastify-5-compatible wrapper around `ws`, which it also pulls in transitively for `WebSocket`/`SocketStream` types).
- `server/src/app.ts` — register the WS plugin and the gateway route plugin inside `buildApp(config)` (the project rule: routes/plugins go here, not `index.ts`). Likely also instantiate the in-memory presence registry here (or in the gateway plugin) and wire it to `app.addHook("onClose", ...)` so heartbeat timers are cleared on shutdown. May add a `declare module "fastify"` decoration if the registry is exposed as `app.presence` (optional — see Decisions).
- `server/src/types.ts` — add the presence/`ready`/`members` payload shapes (`Member`, `ReadyPayload`, `PresenceUpdatePayload`, an `Envelope` type). No presence/member types exist today; `PublicUser` and `SessionRow` are the only relevant existing shapes.
- `server/src/config.ts` + `server/.env.example` — only if heartbeat interval / max-frame-size become env-driven (SPEC.md §12 has no WS knobs today). Lean toward hardcoded constants in the gateway module to avoid config churn (see Decisions); touch these only if the plan elects to make them configurable.

### Likely Created
- `server/src/ws/gateway.ts` (or `server/src/routes/ws.ts`) — the Fastify plugin that registers `GET /ws` with `{ websocket: true }`, performs connect-time auth via `authenticateSession`, sends `ready`, registers the socket in the presence registry, wires inbound-frame handling (envelope parse, size limit, ignore unknown ops), and the heartbeat ping/pong loop. Follow the `routes/auth.ts` `FastifyPluginAsync<Opts>` + `export default` shape.
- `server/src/ws/presence.ts` (or a `PresenceRegistry` class/factory) — the in-memory `Map<userId, Set<socket>>`, `add`/`remove` returning "did this flip first-online / last-offline", a `broadcast(envelope)` helper that iterates all sockets, and `closeUser(userId)` to drop a revoked user's sockets. Kept separate from the route plugin so it is unit-reasoned and testable.
- `context/features/m1-auth-ws-presence/story-004-ws-gateway-presence/contracts/ws-protocol.md` — the deliverable contract (AC requires it) documenting the connect/auth handshake, `ready` payload, and `presence.update` for story 007 (client).

### Read-Only Reference (patterns to follow)
- `server/src/auth.ts` — `authenticateSession(db, rawToken)` is the validator to reuse verbatim (returns `{ user: PublicUser; session: SessionRow } | null`, never throws). Also `parseBearer(authorization)` if a Bearer header transport is chosen.
- `server/src/routes/auth.ts` — plugin idiom: `const x: FastifyPluginAsync<Opts> = async (app, opts) => { ... }; export default x;`, options carry `{ config }`, `app.db` accessed at the top, route handlers as the third arg of `app.get/post`.
- `server/src/app.ts` — `void app.register(plugin, opts)` registration order; the `declare module "fastify"` augmentation pattern; `app.decorate("db", db)` and the `onClose` cleanup hook.
- `server/src/types.ts` — `PublicUser`/`SessionRow`/`UserRow` shapes and the `toPublicUser(row)` mapper to build `members`.
- `server/src/cli.ts` — `revoke-user` runs in a *separate process* (opens its own `openDatabase`), `UPDATE users SET disabled=1` + `UPDATE sessions SET revoked=1 WHERE user_id=?`. This is why active-socket teardown on revoke must be detected by the server, not pushed by the CLI (see Data Flow / Decisions).
- `SPEC.md §7` — the `{ "op", "d" }` envelope and the `ready` / `presence.update` op definitions (`presence.update` payload = `{ userId, status, voiceChannelId }`).

## Existing Patterns

- **ESM with `.js` specifiers**: every relative import carries `.js` (`./auth.js`, `../config.js`) despite `.ts` on disk. New `ws/*.ts` modules must match.
- **Plugin shape**: `routes/auth.ts` is `FastifyPluginAsync<AuthRoutesOptions>` taking `(app, opts)`, reading `app.db` and `opts.config` up top, `export default`. Registered via `void app.register(authRoutes, { config })` in `buildApp`. The WS plugin should mirror this exactly (`void app.register(wsGateway, { config })`).
- **Module augmentation**: `app.ts` already has `declare module "fastify" { interface FastifyInstance { db: Db } ... }`. If the presence registry is exposed on the instance (e.g. `app.presence`), extend the same block.
- **Row→public mapping**: `toPublicUser(userRow)` is the single place snake_case rows become camelCase API shapes. `members` in `ready` should be built from `SELECT * FROM users WHERE disabled = 0` mapped through `toPublicUser` plus a derived `status`.
- **Strict TS, NodeNext**: `strict: true`, `target/lib ES2022`. `@fastify/websocket` v11 is the Fastify-5 line; its handler gives `(socket: WebSocket, req)` (v11 passes the raw `ws` `WebSocket`, not the old `SocketStream` `{ socket }` wrapper — confirm against installed version at plan time).
- **Uniform-failure ethos**: auth REST uses a single opaque failure body to avoid enumeration. The WS analogue is a single defined auth-failure *close code* (no `ready`, no distinguishing message) for missing/invalid/expired/revoked/disabled.
- **Config via `loadConfig()`**: no scattered `process.env`. Any new tunable goes through `config.ts` + `.env.example`.

## Data Flow

**Connect + auth (the transport decision):**
1. Client opens `ws://host:8080/ws`. Browsers/webviews **cannot set the `Authorization` header on a WebSocket handshake** (the `WebSocket` constructor exposes no headers param). Two viable transports:
   - **(A) Query param**: `ws://host/ws?token=<raw-session>` — read in the route handler from `req.query`.
   - **(B) First-frame auth**: connect unauthenticated, client sends `{ "op": "identify", "d": { "token": ... } }` as the first frame; server validates, else closes.
   - **Chosen: (B) first-frame `identify`** (see Decisions) — keeps the raw token out of URLs/server access logs/proxy logs. The handshake: on `open`, server starts a short auth deadline timer; client sends `identify`; server calls `authenticateSession(app.db, token)`. `null` → close with the auth-failure code and **never** send `ready`. Non-null → proceed.
2. On success: build `ready` = `{ user: PublicUser, channels: [], members }`. `members` = every non-disabled user (`SELECT * FROM users WHERE disabled = 0` → `toPublicUser`) annotated with `status: "online" | "offline"` (online iff the registry has ≥1 live socket for that userId) and `voiceChannelId: null` (M1). Send as `{ "op": "ready", "d": ready }`.
3. Register the socket: `registry.add(userId, socket)`. If this is the user's **first** socket, broadcast `{ "op": "presence.update", "d": { userId, status: "online", voiceChannelId: null } }` to all other connected sockets.

**Inbound frames:**
- Enforce a **max frame size** (e.g. set `@fastify/websocket` `options.maxPayload`, plus a guard). Oversized → close or ignore per plan.
- Parse JSON → expect `{ op, d }`. Pre-`identify`: only `identify` is honored; anything else before auth → ignore or close on deadline. Post-`identify`: M1 has **no** client→server ops in scope (`message.send`/`voice.*` are M2/M4), so **unknown/any op is ignored safely** (no throw, no crash). Malformed JSON is swallowed.

**Disconnect:**
- On `close`/`error`: `registry.remove(userId, socket)`. If it was the user's **last** socket, broadcast `presence.update { userId, status: "offline", voiceChannelId: null }`.

**Heartbeat (dead-socket + revocation detection):**
- Per the project (≤10 clients), run a single server-side interval (e.g. every ~30s). Each tick: for every tracked socket, if a prior ping went unanswered (`isAlive` flag cleared on the previous tick, set on `pong`) → `terminate()` (treated as a disconnect → presence offline). Otherwise clear `isAlive` and `ping()`.
- **Revocation:** the CLI `revoke-user`/`revoke-token` runs in a *separate process* and only mutates SQLite — the server gets no in-process signal. So active-socket teardown on revoke is achieved by the heartbeat tick **re-validating** each connection's session via `authenticateSession(app.db, storedRawToken)` (store the raw token on the connection at `identify` time) and, on `null`, closing that socket with the auth-failure code → presence flips offline. This satisfies the AC's firm guarantee ("a revoked session cannot establish a new connection" — enforced at connect) and the active-teardown goal (enforced within one heartbeat interval). Clear the interval in `onClose`.

## Decisions Made

1. **Dependency: add `@fastify/websocket`** (not bare `ws`). It integrates with the existing Fastify plugin/lifecycle model already used for cors/rate-limit/auth, gives `void app.register(...)` symmetry, and brings `ws` (and its types) transitively. Pin to the Fastify-5-compatible major (v11.x at time of writing) — confirm `fastify@^5` peer at plan time.
2. **Auth transport: first-frame `identify` op, not a query param.** WebSocket handshakes can't carry an `Authorization` header from a browser/webview, so the two options are URL query vs. first frame. First-frame keeps the raw session token out of request URLs (which leak into server/proxy access logs, browser history, and `Referer`). The handshake adds an `identify` client→server op + a short post-connect auth deadline; this is the only client→server op M1 introduces. Rationale documented in `ws-protocol.md` for story 007.
3. **Auth-failure close code: one defined code, no `ready`, no detail.** Mirror the REST uniform-401 ethos. Use a single application close code in the 4000–4999 private range (e.g. `4001 "unauthorized"`) for missing/invalid/expired/revoked/disabled and for mid-session revocation. Story 007 keys its "clear session → return to login" on this code. Exact numeric value is a contract detail to fix in `ws-protocol.md`.
4. **Presence registry: in-memory `Map<userId, Set<socket>>`, no broker.** Story + feature explicitly bless this for ≤10 clients. A user is online iff `Set` is non-empty; first-add and last-remove are the broadcast triggers. `add`/`remove` return whether the online state flipped so the route layer broadcasts exactly once.
5. **`members` excludes disabled users.** `ready.members` is built from `WHERE disabled = 0`, consistent with `authenticateSession` rejecting disabled accounts and `login`'s uniform 401 for disabled users. Each member entry = `PublicUser` fields + `status` + `voiceChannelId: null`.
6. **Heartbeat doubles as the revocation reaper.** Rather than add a separate mechanism, the existing heartbeat tick re-runs `authenticateSession` per connection and closes ones that no longer validate. Avoids any CLI→server IPC. Store the connection's raw token at `identify` to enable re-validation.
7. **Frame size limit via `@fastify/websocket` `maxPayload`** plus a defensive length check; constant lives in the gateway module unless the plan decides to surface `WS_MAX_FRAME_BYTES` / `WS_HEARTBEAT_MS` through `loadConfig()`. Default to hardcoded constants to keep SPEC.md §12 / `.env.example` unchanged for M1.
8. **New shapes in `types.ts`, reusing `PublicUser`.** Add `Member` (= `PublicUser & { status: "online" | "offline"; voiceChannelId: number | null }`), `ReadyPayload`, `PresenceUpdatePayload`, and a generic `Envelope<Op, D>` / discriminated union. Keep `toPublicUser` as the row mapper.

## Open Questions

None blocking. The two contract-level specifics to nail down during planning — the exact auth-failure **close code number** and the **heartbeat interval / max-frame-size** values — are design choices, not blockers, and will be fixed in `contracts/ws-protocol.md`.
