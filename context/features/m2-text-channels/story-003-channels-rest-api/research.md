#research

# Research: REST API — create channel & message history

## Files to Touch

### Likely Modified
- `server/src/app.ts` — register the new `channelRoutes` plugin inside `buildApp(config)` via `void app.register(channelRoutes, { config });`, mirroring the existing `void app.register(authRoutes, { config });`. No other change needed (the `db` decoration, `broadcast` decoration, and the `FastifyRequest.user`/`session` augmentation already exist here).
- `server/src/channels.ts` — likely add a tiny position-assignment helper (e.g. `nextChannelPosition(db)` returning `MAX(position)+1`, or `0` for the first channel). There is currently **no** accessor that returns the next/max position, and the create route needs a server-assigned `position`. Alternatively this can live inline in the route, but the data layer is the established home for SQL (see "Decisions Made").

### Likely Created
- `server/src/routes/channels.ts` — the `channelRoutes` Fastify plugin (`FastifyPluginAsync<ChannelRoutesOptions>`), exporting two routes: `POST /api/channels` and `GET /api/channels/:id/messages`. Directly parallels `server/src/routes/auth.ts` in structure (options object carrying `config`, `const db = app.db`, JSON-schema validators declared as `as const` objects, typed `app.post`/`app.get` generics, `default export`).
- `context/features/m2-text-channels/story-003-channels-rest-api/contracts/channels-rest-api.md` — the contract this story `provides_contract`. Documents both endpoints for client stories 004/005 (method, path, auth, request body/query, success + error shapes, pagination semantics). Model it on `context/features/m1-auth-ws-presence/story-003-auth-rest-api/contracts/auth-api.md`.

### Read-Only Reference (patterns to follow)
- `server/src/routes/auth.ts` — the canonical REST route plugin: plugin signature, `AuthRoutesOptions { config }`, `const db = app.db`, JSON-schema `body` validators as `as const`, typed `app.post<{ Body: ... }>(path, { schema, ... }, handler)`, `reply.code(n).send(...)`, `{ preHandler: requireAuth }` on guarded routes.
- `server/src/auth.ts` — `requireAuth` preHandler (attaches `request.user: PublicUser` + `request.session`), `parseBearer`, uniform `401 { error: "unauthorized" }`.
- `server/src/channels.ts` — the story-001 accessors: `createChannel`, `getChannelById`, `getChannelMessages`, `clampHistoryLimit` (all take `db` first). These are the data layer; the route is a thin adapter over them.
- `server/src/types.ts` — `PublicChannel`/`PublicMessage` shapes + `toPublicChannel`/`toPublicMessage` mappers; `ChannelCreatePayload`.
- `server/src/ws/gateway.ts` (lines 198–224) — reference for how the WS path validates a `message.send` and how `channel.create`/`message.create` envelopes are shaped; also shows `app.broadcast` is **not** used there (the gateway uses its own `hub`), but the contract directs the REST route to use `request.server.broadcast`.
- `context/features/m1-auth-ws-presence/story-003-auth-rest-api/contracts/auth-api.md` — JSON conventions (camelCase, epoch-ms), the `400 { "error": "Bad Request" }` default-validation body, `401 { "error": "unauthorized" }`, and the endpoint-reference table format to copy into the new contract.

## Existing Patterns

**Route plugin shape (from `routes/auth.ts`).** A route module is a `FastifyPluginAsync<TOptions>` where `TOptions` is `{ config: Config }`. Inside: destructure `const { config } = opts;`, grab `const db = app.db;`, declare JSON-schema validators as top-level `const xSchema = { body: {...} } as const;`, then register routes with typed generics, e.g. `app.post<{ Body: { name: string; type: string } }>("/api/channels", { schema, preHandler: requireAuth }, async (request, reply) => {...})`. It is registered in `app.ts` with `void app.register(channelRoutes, { config });`. Default-exported.

**Auth guarding.** Authenticated routes pass `{ preHandler: requireAuth }` (imported from `../auth.js`). On success `request.user` (`PublicUser`, has `.id`) and `request.session` are populated; on failure the preHandler short-circuits with `401 { error: "unauthorized" }`. `created_by` for a new channel = `request.user!.id`. (The `FastifyRequest.user?`/`session?` module augmentation already lives in `app.ts`.)

**Validation policy / error bodies.** M1 routes lean on Fastify's built-in JSON-schema body validation: a malformed/oversized/wrong-type body yields the framework default `400 { "error": "Bad Request", "message": "..." }` — the auth-api contract documents this as `400 { "error": "Bad Request" }`. The new route follows suit:
- `POST /api/channels` body schema: `{ type: "object", required: ["name","type"], properties: { name: { type: "string", minLength: 1, maxLength: <cap> }, type: { type: "string", enum: ["text"] } }, additionalProperties: false }`. The `enum: ["text"]` is exactly how the story's "reject `type` ≠ `text`" requirement is satisfied at the 400 level (and is forward-compatible: M4 will widen the enum). `maxLength` enforces the name cap. **Whitespace-only** names pass `minLength: 1` at the schema level, so the handler must additionally `name.trim()` and return `400 { error: "channel_name_invalid" }` (or re-`reply.code(400)`) when the trimmed name is empty — schema can't express "non-empty after trim". (Mirrors how the WS gateway trims `content` and rejects empty-after-trim; here it surfaces as a 400 instead of a silent ignore.)
- `GET /api/channels/:id/messages` validators: `params` schema `{ id: { type: "integer", minimum: 1 } }` (Fastify coerces the path string to an integer; a non-numeric id 400s); `querystring` schema with `before` and `limit` as `{ type: "integer", minimum: 1 }` and **not** required (Fastify coerces query strings to integers). `clampHistoryLimit` already tolerates `undefined`/non-finite/`<=0`, so an absent or odd `limit` falls back to the default cleanly.

**Custom (non-schema) error bodies** use `reply.code(404).send({ error: "channel_not_found" })` — matching M1's `reply.code(401).send({ error: "..." })` style (snake_case error codes, single `error` key).

**Response mapping.** Never send a raw `*Row`. Map with `toPublicChannel(row)` / `messages.map(toPublicMessage)` before `reply.send`. This guarantees camelCase + epoch-ms per the JSON conventions.

## Data Flow

**`POST /api/channels`:**
1. `requireAuth` preHandler validates the Bearer token (`authenticateSession`), sets `request.user`. Missing/invalid → `401 { error: "unauthorized" }`.
2. JSON-schema body validation: missing fields / wrong types / `type !== "text"` / over-long name → `400` (Fastify default body).
3. Handler trims `name`; empty-after-trim → `400`.
4. Compute `position` (server-assigned — next position helper / `MAX(position)+1`).
5. `createChannel(db, { name: <trimmed or raw>, type: "text", position, createdBy: request.user!.id })` → `ChannelRow` (story-001 accessor; inserts + re-SELECTs).
6. `request.server.broadcast({ op: "channel.create", d: { channel: toPublicChannel(row) } })` — the story-002 broadcast helper (`app.broadcast`, decorated in `app.ts`, backed by `BroadcastHub`) pushes the event to every authed WS socket, no `except`.
7. `reply.code(201).send(toPublicChannel(row))`.

**`GET /api/channels/:id/messages?before=&limit=`:**
1. `requireAuth` → `401` on failure.
2. `params`/`querystring` schema validation (id coerced to int; before/limit optional ints).
3. `getChannelById(db, id)` → `undefined` ⇒ `reply.code(404).send({ error: "channel_not_found" })`.
4. `const limit = clampHistoryLimit(query.limit, { defaultLimit: config.messageHistoryDefaultLimit, maxLimit: config.messageHistoryMaxLimit })`.
5. `const rows = getChannelMessages(db, id, { before: query.before, limit })` — keyset, `id < before` when `before` given, `ORDER BY id DESC` (newest-first). A `before` past the oldest row ⇒ empty array (natural SQL result).
6. `reply.send(rows.map(toPublicMessage))` — a `PublicMessage[]`, newest-first (the contract documents ordering so clients 004/005 reverse for display).

No second DB connection is opened anywhere — `app.db` (the shared `Db`) is used throughout, satisfying the "no global singletons / single connection" criterion.

## Decisions Made

1. **New file `server/src/routes/channels.ts` rather than extending `routes/auth.ts`.** Each REST concern is its own plugin file (`routes/auth.ts` is auth-only); a `channelRoutes` plugin is the obvious parallel and is exactly what the story text suggests ("a `channelRoutes` plugin"). Registered in `app.ts` right after `authRoutes`.

2. **`position` = `MAX(position) + 1` (first channel gets `0`), assigned server-side via a small accessor added to `channels.ts`.** The story requires a "server-assigned `position`" but neither the story-001 contract nor the existing `channels.ts` provides a next-position accessor, and the `channels-data.md` contract only fixes the four existing accessors (it doesn't forbid additions). `MAX+1` gives a stable monotonic append order consistent with `listChannels` ordering (`ORDER BY position, id`) and needs no reordering logic (reorder is an explicit feature non-goal). Putting the `SELECT MAX(position)` in `channels.ts` keeps all channel SQL in the data layer (consistent with the module's stated role as "single source of truth for channel persistence"); doing it inline in the route would be the only raw SQL outside that module. A trivial alternative — always insert `position = 0` — was rejected because it makes `listChannels`' position ordering meaningless across multiple channels.

3. **`type` validated via JSON-schema `enum: ["text"]`** rather than a handler `if`. This yields the same `400` "Bad Request" body M1 uses for bad input, keeps the rejection declarative, and widens cleanly to `["text","voice"]` in M4. The handler still passes the literal `"text"` to `createChannel` (whose input type is `"text" | "voice"`).

4. **Whitespace-only name rejected in the handler with a custom `400` code** (`channel_name_invalid`), since JSON-schema `minLength` can't express "non-empty after trim". The trimmed value is what gets stored (mirrors the gateway trimming `message.send` content, and matches the AC wording "it trims and validates `name`"). Duplicate names are intentionally allowed (feature spec: `channels.name` is not UNIQUE).

5. **Channel-name max length = reuse `64`** (the same cap M1's `username` uses in `routes/auth.ts`). There is no configured channel-name length and SPEC §8/§9 don't specify one; matching the existing 64-char identifier cap is the least-surprising local convention and avoids introducing a new config knob for a value the spec doesn't call out. (If the planner prefers a config field, it would slot into `loadConfig()` + `.env.example` like `maxMessageLength` — but reusing the literal `64` is simpler and consistent with M1.)

6. **`before`/`limit` typed as optional `integer` query params with Fastify coercion**; no manual `Number(...)` parsing in the handler. Fastify's querystring schema coerces `"50"` → `50`, and `clampHistoryLimit`/`getChannelMessages` already guard `undefined`/non-finite, so the handler stays a thin pass-through. This matches story-001's contract note that `clampHistoryLimit` maps missing/invalid `?limit=` to the default.
