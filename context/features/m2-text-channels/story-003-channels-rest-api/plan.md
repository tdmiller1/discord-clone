#plan

# Plan: REST API — create channel & message history

## Summary
Add a `channelRoutes` Fastify plugin (`server/src/routes/channels.ts`) exposing `POST /api/channels` (create a text channel, broadcast `channel.create`, return `201 PublicChannel`) and `GET /api/channels/:id/messages` (keyset history page, newest-first), both Bearer-guarded via M1's `requireAuth`, registered inside `buildApp(config)`, plus a small `nextChannelPosition(db)` helper in the data layer and the `contracts/channels-rest-api.md` contract. All accessors and broadcast helpers already exist from stories 001/002 — this story is a thin REST adapter over them.

All `research.md` "Decisions Made" are treated as final and carried into the steps below. No genuine external blockers exist. Two decisions worth restating in this Summary, both derived from existing code: (1) channel-name max length reuses the literal `64` already used for `username` in `routes/auth.ts` — config already exposes `maxMessageLength`/`messageHistory*Limit` but **no** channel-name knob, and SPEC §8/§9 specify none, so no new config field is introduced; (2) `position` is server-assigned as `MAX(position)+1` (first channel = `0`) via a new `nextChannelPosition(db)` accessor added to `channels.ts`, keeping all channel SQL in the data layer.

## Implementation Steps

### Step 1: Add `nextChannelPosition` accessor to the data layer
**File(s):** `server/src/channels.ts`
**Action:** modify
**Description:** Add a small accessor returning the next append position for a new channel: `MAX(position) + 1`, or `0` when the table is empty. This keeps the only `SELECT MAX(position)` inside the data layer (the module's stated role as the single source of truth for channel SQL), so the route stays free of raw SQL. The append-only `MAX+1` matches `listChannels`' `ORDER BY position, id` and needs no reorder logic (reorder is an explicit feature non-goal).
**Diff shape:**
- Add: `export function nextChannelPosition(db: Db): number` that runs `SELECT MAX(position) AS maxPos FROM channels`, reads the single row's `maxPos` (which is `null` on an empty table), and returns `maxPos === null ? 0 : maxPos + 1`.
- Add: a short JSDoc comment matching the module's existing style (note: monotonic append position, `0` for the first channel, consistent with `listChannels` ordering).
- Remove: nothing.
- Change: nothing in existing functions.

### Step 2: Create the `channelRoutes` plugin file with `POST /api/channels`
**File(s):** `server/src/routes/channels.ts`
**Action:** create
**Description:** New `FastifyPluginAsync<ChannelRoutesOptions>` mirroring `routes/auth.ts`: destructure `const { config } = opts;`, `const db = app.db;`, declare a top-level `createChannelSchema` as a `const … as const` body validator, and register the create route guarded by `{ preHandler: requireAuth }`. Imports use `.js` specifiers (ESM/NodeNext). Default-exported.
**Diff shape:**
- Add: imports — `type { FastifyInstance, FastifyPluginAsync } from "fastify"`, `type { Config } from "../config.js"`, `{ requireAuth } from "../auth.js"`, `{ createChannel, getChannelById, getChannelMessages, clampHistoryLimit, nextChannelPosition } from "../channels.js"`, `{ toPublicChannel, toPublicMessage } from "../types.js"`.
- Add: `interface ChannelRoutesOptions { config: Config }`.
- Add: `const createChannelSchema = { body: { type: "object", required: ["name", "type"], properties: { name: { type: "string", minLength: 1, maxLength: 64 }, type: { type: "string", enum: ["text"] } }, additionalProperties: false } } as const;` — the `enum: ["text"]` is exactly how `type !== "text"` is rejected at the `400` level (forward-compatible: M4 widens to `["text","voice"]`); `maxLength: 64` caps the name, reusing M1's `username` cap.
- Add: `const channelRoutes: FastifyPluginAsync<ChannelRoutesOptions> = async (app, opts) => { … };` with `app.post<{ Body: { name: string; type: "text" } }>("/api/channels", { schema: createChannelSchema, preHandler: requireAuth }, handler)`.
- Add: handler body —
  1. `const name = request.body.name.trim();` then `if (name.length === 0) return reply.code(400).send({ error: "channel_name_invalid" });` (schema `minLength: 1` can't express non-empty-after-trim; mirrors the gateway trimming `message.send` content).
  2. `const position = nextChannelPosition(db);`
  3. `const row = createChannel(db, { name, type: "text", position, createdBy: request.user!.id });` (pass the literal `"text"`; `createChannel`'s input type is `"text" | "voice"`).
  4. `const channel = toPublicChannel(row);`
  5. `request.server.broadcast({ op: "channel.create", d: { channel } });` (story-002 `app.broadcast` decoration, no `except` — reaches every authed socket incl. the creator).
  6. `return reply.code(201).send(channel);`
- Add: `export default channelRoutes;`
- Remove / Change: nothing (new file).

### Step 3: Add `GET /api/channels/:id/messages` to the plugin
**File(s):** `server/src/routes/channels.ts`
**Action:** modify
**Description:** Add the history endpoint to the same plugin, also `requireAuth`-guarded, with `params` and `querystring` schemas so Fastify coerces the path id and the `before`/`limit` query strings to integers. The handler is a thin pass-through over `getChannelById` + `clampHistoryLimit` + `getChannelMessages`.
**Diff shape:**
- Add: `const messageHistorySchema = { params: { type: "object", required: ["id"], properties: { id: { type: "integer", minimum: 1 } }, additionalProperties: false }, querystring: { type: "object", properties: { before: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } }, additionalProperties: false } } as const;` (`before`/`limit` are **not** required; a non-numeric id or query value → framework `400`).
- Add: `app.get<{ Params: { id: number }; Querystring: { before?: number; limit?: number } }>("/api/channels/:id/messages", { schema: messageHistorySchema, preHandler: requireAuth }, handler)`.
- Add: handler body —
  1. `const { id } = request.params;`
  2. `if (!getChannelById(db, id)) return reply.code(404).send({ error: "channel_not_found" });`
  3. `const limit = clampHistoryLimit(request.query.limit, { defaultLimit: config.messageHistoryDefaultLimit, maxLimit: config.messageHistoryMaxLimit });`
  4. `const rows = getChannelMessages(db, id, { before: request.query.before, limit });` (keyset: `id < before` when `before` given; `ORDER BY id DESC`, newest-first; a `before` past the oldest row → natural empty array).
  5. `return reply.send(rows.map(toPublicMessage));` (a `PublicMessage[]`, newest-first).
- Remove / Change: nothing else.

### Step 4: Register `channelRoutes` in `buildApp`
**File(s):** `server/src/app.ts`
**Action:** modify
**Description:** Wire the new plugin into the app right after `authRoutes`, mirroring its registration. All required decorations (`app.db`, `app.broadcast`, the `FastifyRequest.user`/`session` augmentation) already exist in this file — no other change.
**Diff shape:**
- Add: `import channelRoutes from "./routes/channels.js";` near the other route imports.
- Add: `void app.register(channelRoutes, { config });` immediately after `void app.register(authRoutes, { config });`, with a one-line comment ("Channel REST endpoints: create channel + message history (SPEC.md §9).").
- Remove / Change: nothing.

### Step 5: Write the `channels-rest-api.md` contract
**File(s):** `context/features/m2-text-channels/story-003-channels-rest-api/contracts/channels-rest-api.md`
**Action:** create
**Description:** The contract this story `provides_contract`, documenting both endpoints for client stories 004/005. Model the structure on `m1-auth-ws-presence/story-003-auth-rest-api/contracts/auth-api.md`: a `#contract` header, JSON conventions (camelCase, epoch-ms), the `PublicChannel`/`PublicMessage` shapes, an endpoint-reference table, per-endpoint request/behavior/error detail, and explicit pagination semantics (keyset on `id`, `id < before`, newest-first ordering so clients reverse for display, default `50` clamped to `messageHistoryMaxLimit`). Note the `channel.create` broadcast side effect of the create endpoint.
**Diff shape:**
- Add: full contract document (see "API / Interface Changes" + "New Types / Schemas / Contracts" below for the authoritative shapes/values to transcribe).
- Remove / Change: nothing (new file).

## New Types / Schemas / Contracts

No new TypeScript interfaces are introduced — `PublicChannel`, `PublicMessage`, `toPublicChannel`, `toPublicMessage` already exist in `server/src/types.ts` and are the authoritative response shapes. One new exported function and one local options interface:

```ts
// server/src/channels.ts — new accessor
export function nextChannelPosition(db: Db): number; // MAX(position)+1, or 0 if empty

// server/src/routes/channels.ts — plugin-local
interface ChannelRoutesOptions {
  config: Config;
}
```

Response shapes the contract pins down (from `types.ts`, unchanged):

```ts
PublicChannel {
  id: number;
  name: string;
  type: "text" | "voice"; // M2 only ever creates/returns "text"
  position: number;        // server-assigned, monotonic append (0-based)
  createdBy: number | null;
  createdAt: number;       // epoch ms
}

PublicMessage {
  id: number;
  channelId: number;
  authorId: number;
  content: string;
  attachmentId: number | null; // always null in M2
  createdAt: number;           // epoch ms
}
```

`channel.create` WS envelope emitted on create (already typed as `ChannelCreatePayload` in `types.ts`):

```ts
{ op: "channel.create", d: { channel: PublicChannel } }
```

## Configuration / Environment Changes

None. The story reuses existing config: `config.messageHistoryDefaultLimit` (env `MSG_HISTORY_DEFAULT_LIMIT`, default `50`) and `config.messageHistoryMaxLimit` (env `MSG_HISTORY_MAX_LIMIT`, default `100`) for history paging. The channel-name max length is the inline literal `64` (matching M1's `username` cap), deliberately **not** a new config knob (Decision 5). No new persisted columns — `channels.position` already exists from story 001's schema.

## API / Interface Changes

| Surface    | Identifier                          | Request / Input                                                                 | Response / Output                                                  | Notes |
| ---------- | ----------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----- |
| HTTP route | `POST /api/channels`                | Bearer; body `{ name: string (1..64, non-empty after trim), type: "text" }`     | `201` `PublicChannel`                                              | Also broadcasts `{ op:"channel.create", d:{ channel } }` to all sockets. `created_by = request.user.id`, server-assigned `position`. |
| HTTP route | `GET /api/channels/:id/messages`    | Bearer; path `id: integer ≥1`; query `before?: integer ≥1`, `limit?: integer ≥1`| `200` `PublicMessage[]` (newest-first)                             | Keyset on `id` (`id < before`). `limit` defaults to `50`, clamped to `messageHistoryMaxLimit` (100). `404 { error:"channel_not_found" }` for unknown id; `before` past oldest → `[]`. |
| Function   | `nextChannelPosition(db)`           | `db: Db`                                                                         | `number` (`MAX(position)+1`, or `0`)                              | New export in `server/src/channels.ts`. |

Error bodies:
- `400 { "error": "Bad Request" }` — Fastify schema validation (missing/wrong-type field, `type !== "text"`, name > 64 chars, unknown property, non-integer `id`/`before`/`limit`).
- `400 { "error": "channel_name_invalid" }` — name empty after `trim()` (handler-level, schema can't express it).
- `401 { "error": "unauthorized" }` — missing/invalid Bearer (from `requireAuth`).
- `404 { "error": "channel_not_found" }` — history fetch for an unknown channel id.

## Edge Cases & Gotchas

- Missing/invalid Bearer on either route → `401 { error:"unauthorized" }` via `requireAuth` preHandler — Step 2 & Step 3.
- `type` ≠ `"text"` (e.g. `"voice"`) → `400 Bad Request` via `enum: ["text"]` (voice is M4) — Step 2.
- Empty or whitespace-only `name` → `400`: `minLength:1` catches empty string at the schema level; whitespace-only passes the schema but is rejected as `channel_name_invalid` after `trim()` in the handler — Step 2.
- Name over the cap (> 64 chars) → `400 Bad Request` via `maxLength: 64` — Step 2.
- Duplicate channel names are **allowed** (`channels.name` is not UNIQUE per SPEC §8 / feature spec) — no handling needed; noted in the contract — Step 5.
- The stored name is the **trimmed** value (matches AC "it trims and validates `name`" and the gateway's content-trim behavior) — Step 2.
- `position` server-assigned, never client-supplied; `additionalProperties: false` rejects a client-sent `position`/`createdBy` with `400` — Step 2.
- Creator also receives the `channel.create` broadcast (no `except`); the client must tolerate a `channel.create` for a channel it just created (dedupe by `id`, per feature spec) — broadcast is Step 2, dedupe is downstream (story 004).
- Nonexistent channel id on history → `404 channel_not_found` (checked before paging) — Step 3.
- `before` cursor past the oldest message id → empty array (natural SQL result of `id < before`) — Step 3.
- Absent / `0` / non-finite `limit` → falls back to default `50` via `clampHistoryLimit`; `limit` over cap → clamped to `100` — Step 3.
- Non-integer or `< 1` path `id` / query `before` / `limit` → `400 Bad Request` (schema `type:"integer", minimum:1`; Fastify coerces numeric strings, rejects non-numeric) — Step 3.
- Single DB connection: every accessor takes the shared `app.db`; no second connection or global singleton opened — Steps 1–4.
- Empty history (valid channel, no messages) → `200 []` (not a 404) — Step 3.

## Acceptance Criteria Checklist

- [ ] `POST /api/channels` (Bearer via `requireAuth`) accepts `{ name, type:"text" }`, trims+validates `name` (non-empty, ≤ max), rejects `type` ≠ `"text"`, creates via `createChannel` with `created_by = request.user.id` + server-assigned `position`, returns `201 PublicChannel`, emits `channel.create` to all sockets → Step 1, Step 2, Step 4
- [ ] `GET /api/channels/:id/messages?before=&limit=50` (Bearer) returns `PublicMessage[]` via keyset pagination on `id` (`id < before`), newest-first, `limit` defaulted to 50 and clamped to cap; nonexistent channel → `404`; `before` past oldest → empty array → Step 3, Step 4
- [ ] Responses are camelCase JSON with epoch-ms timestamps; errors well-formed (`400` malformed/empty-or-oversized name/bad type, `404 channel_not_found`, `401 unauthorized`) → Step 2, Step 3 (mappers `toPublicChannel`/`toPublicMessage` guarantee camelCase/epoch-ms)
- [ ] Routes registered inside `buildApp(config)` as a `channelRoutes` plugin reading `fastify.db` — no second db connection, no global singletons → Step 4 (Steps 1–3 all use `app.db`)
- [ ] `npm run typecheck` passes; verifiable with `curl` (create channel, observe `channel.create` on `wscat`, send WS messages, fetch via history with `before`/`limit`) → Steps 1–4 (typed generics + `.js` ESM specifiers; data accessors pre-exist)
- [ ] `contracts/channels-rest-api.md` documents both endpoints (method, path, auth, request body/query, success + error shapes, pagination semantics) for stories 004/005 → Step 5
