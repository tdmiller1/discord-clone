#research

# Research: WS gateway — message.send, broadcasts & ready.channels

## Files to Touch

### Likely Modified
- `server/src/ws/gateway.ts` — The core of this story. Flip `buildReady`'s `channels: []` to `listChannels(db).map(toPublicChannel)`; add a `message.send` branch to the post-auth `socket.on("message")` handler that validates → persists via `insertMessage` → broadcasts `message.create`. Currently the post-auth block is a no-op comment ("M1 defines no in-scope client→server ops"). Also wire up the shared broadcast hub so the REST layer (story 003) can emit `channel.create`.
- `server/src/types.ts` — `ReadyPayload.channels` is typed `never[]` (with the comment "becomes `PublicChannel[]` in story 002"); change it to `PublicChannel[]`. Add the new envelope payload interfaces: `MessageSendPayload { channelId: number; content: string; attachmentId?: number | null }` (client→server), `MessageCreatePayload { message: PublicMessage }` and `ChannelCreatePayload { channel: PublicChannel }` (server→client). Extend the `ServerEvent` and `ClientCommand` discriminated unions with the new ops (`message.create`, `channel.create`, `message.send`). `PublicChannel`, `PublicMessage`, `toPublicChannel`, `toPublicMessage` already exist (added by story 001), so no new mappers are needed.
- `server/src/app.ts` — The broadcast helper must be visible to BOTH the gateway plugin and the (future story 003) REST routes. Because plugins are registered with plain `app.register(...)` and there is no `fastify-plugin`, anything `decorate`d *inside* the gateway plugin is encapsulated and invisible to sibling plugins. Follow the existing `app.decorate("db", db)` pattern: construct the shared broadcast hub at `buildApp` level, `app.decorate("broadcast", hub.broadcast)` (or decorate the hub), and pass it into `wsGateway` via its register options — mirroring how `config` is already threaded into `wsGateway`/`authRoutes`.

### Likely Created
- `server/src/ws/hub.ts` (optional, recommended) — A small `BroadcastHub` (or `SocketHub`) that owns the `Set<WebSocket>` of all authed sockets and a `broadcast(env, except?)` method (serialize once, send to every OPEN socket). This is the "reusable broadcast helper" the AC asks for. Today `PresenceRegistry.broadcast` already does exactly this over its `Map<userId, Set<socket>>`, but `PresenceRegistry` is keyed by user and is presence-specific; a flat all-sockets hub is cleaner to expose to the REST layer. See Decision 1 — it is also viable to just reuse/expose `PresenceRegistry.broadcast` and skip a new file.
- `server/src/ws/messaging.ts` (optional) — A pure `handleMessageSend(db, config, payload) -> { ok: true, message: PublicMessage } | { ok: false }` validator+persister, kept framework-agnostic like `channels.ts`/`presence.ts`. Optional; the logic is small enough to inline in the gateway. See Decision 3.

### Read-Only Reference (patterns to follow)
- `server/src/ws/gateway.ts` (whole file) — the envelope parse/guard pattern (`toBuffer` → `JSON.parse` in try/catch → `typeof frame !== "object"` → `typeof op !== "string"`), the per-connection `ConnState`, and the auth gate (`if (!state.authed) ...`). The `message.send` handler slots into the post-auth section and must reuse this exact defensive style (swallow malformed frames, never throw, never close on a bad payload).
- `server/src/ws/presence.ts` — `PresenceRegistry.broadcast(env, except?)`: the canonical "serialize once, loop sockets, skip `except`, guard `readyState === OPEN`" implementation to copy for the new hub. Also models the framework-agnostic, unit-testable class shape.
- `server/src/channels.ts` — `insertMessage`, `getChannelById`, `listChannels` (the story-001 accessors this story consumes verbatim). Note the `db`-first arg convention.
- `server/src/types.ts` — `toPublicChannel`, `toPublicMessage`, `toPublicUser` mappers and the `Envelope<Op, D>` / `ServerEvent` / `ClientCommand` union conventions to extend.
- `server/src/app.ts` — `app.decorate("db", db)` + the `app.register(plugin, { config })` option-threading pattern to mirror for the broadcast hub.
- `server/src/routes/auth.ts` — the `FastifyPluginAsync<Options>` + `interface XOptions { config: Config }` plugin shape (the gateway and story 003 routes both use it).

## Existing Patterns

**Inbound frame handling (gateway.ts).** Every frame goes through `toBuffer(raw)` → size guard (`WS_MAX_FRAME_BYTES = 64KB`, also enforced by `ws` `maxPayload`) → `JSON.parse` in a `try/catch` that `return`s on failure (never throws) → reject non-object / non-string-`op`. Pre-auth, only `op === "identify"` is honored; everything else `return`s. Post-auth is currently an empty branch with a comment. The `message.send` handler is added there with the same shape: read `frame.d`, type-narrow each field, and on any validation failure simply `return` (the AC explicitly allows "ignored safely" and says it must never tear down the socket).

**Auth gate.** `state.authed` / `state.userId` are set on successful `identify`. The `message.send` branch runs only inside the `// Post-auth` region, so AC "only sockets that completed the M1 auth handshake may send" is satisfied by construction. `author_id` for the persisted message is `state.userId` (asserted non-null in the authed branch).

**Broadcast.** `PresenceRegistry.broadcast(env: Envelope, except?: WebSocket)` serializes `env` once with `JSON.stringify` and sends to every tracked socket with `readyState === OPEN`, optionally skipping `except`. For `message.create` / `channel.create` the AC requires an echo to the sender, so the broadcast is called WITHOUT `except` (unlike `presence.update`, which passes the joining socket as `except`).

**Persistence accessors (channels.ts).** `db`-first, framework-agnostic functions that re-`SELECT` the inserted row and return the full `*Row`; the gateway maps with `toPublic*` and broadcasts — no second round-trip. `insertMessage(db, { channelId, authorId, content, attachmentId })` is called with `attachmentId: null` per the contract and AC ("attachmentId is ignored in M2, stored NULL").

**Plugin option threading.** `wsGateway` is `FastifyPluginAsync<WsGatewayOptions>` with `interface WsGatewayOptions { config: Config }`, registered `app.register(wsGateway, { config })`. New cross-plugin state (the hub) is threaded the same way and additionally decorated on `app` for story 003.

**Config.** All three M2 tunables already exist in `config.ts` and `.env.example` (added by story 001): `maxMessageLength` (4000), `messageHistoryDefaultLimit` (50), `messageHistoryMaxLimit` (100). This story only *reads* `config.maxMessageLength` for `content` validation — no new config is required.

## Data Flow

**`ready.channels` (connect):**
1. Client sends `{ op: "identify", d: { token } }`.
2. Gateway `authenticateSession(db, token)` succeeds → `registry.add(...)` → `buildReady(user)`.
3. `buildReady` currently returns `channels: []`. New: `channels: listChannels(db).map(toPublicChannel)` (story-001 accessor). `members` and the handshake are untouched.
4. `socket.send({ op: "ready", d: { user, channels, members } })`.

**`message.send` → `message.create` (live post):**
1. Authed client sends `{ op: "message.send", d: { channelId, content, attachmentId? } }`.
2. Gateway message handler: parse/guard (existing) → `op === "message.send"` branch.
3. Validate: `frame.d` is an object; `channelId` is a finite number; `content` is a string, non-empty after `.trim()`, and `content.length <= config.maxMessageLength`; `getChannelById(db, channelId)` is defined (channel exists). Any failure → `return` (no persist, no broadcast, socket stays up). `attachmentId` is read but discarded.
4. Persist: `insertMessage(db, { channelId, authorId: state.userId, content, attachmentId: null })` → `MessageRow`.
5. Map: `toPublicMessage(row)` → `PublicMessage`.
6. Broadcast: `hub.broadcast({ op: "message.create", d: { message } })` to ALL authed sockets including the sender (no `except`).

**`channel.create` (story 003 calls into this story's helper):**
1. Story 003's `POST /api/channels` calls `createChannel(db, ...)` → `ChannelRow`.
2. It then calls the decorated helper: `app.broadcast({ op: "channel.create", d: { channel: toPublicChannel(row) } })` to push the new channel live to everyone. This story only provides the helper + payload contract; the route itself is out of scope.

## Decisions Made

1. **Broadcast hub: new flat `Set<WebSocket>` hub vs. reuse `PresenceRegistry.broadcast`.** Chose a small dedicated all-sockets hub (`server/src/ws/hub.ts`) constructed in `buildApp`, decorated on `app`, and passed into `wsGateway`. Rationale: (a) the AC asks for "a reusable broadcast helper exposed on the gateway hub / `app`" that story 003 (a *sibling* plugin) can call — and because no `fastify-plugin` is in deps, a decorate inside the gateway plugin is encapsulated and invisible to the REST plugin, so the hub must live at `buildApp` level regardless; (b) `PresenceRegistry` is conceptually keyed by user and presence-scoped, so a flat hub keyed only by socket is a cleaner public surface and avoids coupling the REST layer to presence internals. The gateway registers/deregisters each authed socket in the hub at the same points it already calls `registry.add`/`registry.remove`. (Acceptable alternative: skip the new file and decorate `registry.broadcast` directly — fewer files, but leaks the presence map to REST.)

2. **`message.create` / `channel.create` echo to sender.** The AC and feature edge-cases require the sender to receive its own `message.create` (renders from the authoritative server row, enables id-based dedupe on the client). So these broadcasts pass NO `except` argument — contrasting with `presence.update`, which passes the joining socket as `except`. Documented explicitly in the contract.

3. **Validation: inline in the gateway vs. extracted `messaging.ts` module.** Leaning toward inlining the `message.send` validation+persist in the gateway's message handler (it is ~10 lines and has one caller), matching how `identify` is handled inline. Extracting a pure `handleMessageSend` helper (like `presence.ts`) is a reasonable alternative if the planner wants it unit-testable in isolation; either satisfies the AC. Flagged for the plan to decide.

4. **Invalid `message.send` → silently ignored (no error op).** The AC offers "ignored safely OR a defined error op". Chose silent `return` to match the entire existing gateway philosophy (malformed JSON, bad `identify` payloads, unknown ops are all swallowed; only auth failure closes the socket). Avoids inventing a new error envelope the rest of the protocol/SPEC §7 doesn't define. The contract will state errors are ignored.

5. **`channelId` / `attachmentId` type narrowing.** Validate `channelId` with `typeof === "number" && Number.isFinite(...)` (mirroring `getChannelMessages`'s `Number.isFinite` guard in channels.ts). `attachmentId` is read but never validated or used (stored `null`), so no narrowing needed beyond ignoring it.
