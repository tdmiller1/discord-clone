#research

# Research: Server data layer — channels & messages

## Files to Touch

### Likely Modified
- `server/src/schema.ts` — extend the single `SCHEMA_SQL` string with `CREATE TABLE IF NOT EXISTS channels` / `messages` (exactly per SPEC.md §8) plus the keyset index `idx_messages_channel_id`. Update the module doc comment which currently says "`channels`/`messages`/`attachments` are deferred to M2/M3".
- `server/src/types.ts` — add `ChannelRow`/`MessageRow` (snake_case row shapes), `PublicChannel`/`PublicMessage` (camelCase API shapes), and the `toPublicChannel`/`toPublicMessage` mappers (mirror the existing `UserRow`/`PublicUser`/`toPublicUser` trio). Optionally update `ReadyPayload.channels` from `never[]` to `PublicChannel[]` — but that field is owned/consumed by story 002's gateway work, so leaving it is also defensible (see Decisions).
- `server/src/config.ts` — add `maxMessageLength`, `messageHistoryDefaultLimit`, `messageHistoryMaxLimit` to the `Config` interface and `loadConfig()` (via the existing `num()` helper).
- `server/.env.example` — document the three new env vars with their defaults.

### Likely Created
- `server/src/channels.ts` — new accessor module built on the `Db` handle, exporting `createChannel`, `getChannelById`, `listChannels`, `insertMessage`, `getChannelMessages`. This is the "one source of truth" the story names; stories 002 (gateway) and 003 (REST) import from here.
- `context/features/m2-text-channels/story-001-channels-messages-schema/contracts/channels-data.md` — the contract documenting tables, accessor API, pagination semantics, and the public JSON shapes (consumed by stories 002 + 003, both `depends_on: [001]`).

### Read-Only Reference (patterns to follow)
- `server/src/types.ts` — the `UserRow` → `PublicUser` → `toPublicUser` trio is the exact template for the new Row/Public/mapper triples.
- `server/src/auth.ts` — `authenticateSession(db, ...)` is the model for a framework-agnostic, `Db`-first accessor function that does `db.prepare(...).get(...) as XRow | undefined` and returns typed results. Mirror this signature style (`db` as first arg).
- `server/src/cli.ts` — `mintToken` / `revokeUser` show the insert + `db.transaction(...)` + `Number(insert.lastInsertRowid)` patterns for write accessors.
- `server/src/routes/auth.ts` — `issueSession` shows the `INSERT ... VALUES (...)` + `lastInsertRowid` + re-`SELECT` to return the full row pattern that `createChannel`/`insertMessage` should follow.
- `context/features/m1-auth-ws-presence/story-001-data-layer-auth-schema/contracts/data-and-crypto.md` — the structural template for `contracts/channels-data.md` (table tables, module API code blocks, usage notes for downstream stories).
- `server/src/config.ts` — the `num(name, fallback)` helper and `loadConfig()` shape for the new tunables.
- `server/src/db.ts` — `openDatabase` already calls `applySchema` on every open with `PRAGMA foreign_keys = ON`; the new schema must coexist with that (see the attachment_id FK deferral note).

## Existing Patterns

**Schema** (`server/src/schema.ts`): one exported `applySchema(db: Database): void` that runs a single multi-statement `SCHEMA_SQL` template via `db.exec`. Every table is `CREATE TABLE IF NOT EXISTS` with `id INTEGER PRIMARY KEY AUTOINCREMENT`, `created_at INTEGER NOT NULL` (epoch ms via `Date.now()`), booleans as `INTEGER ... DEFAULT 0`, and FKs declared inline as `FOREIGN KEY (col) REFERENCES users(id)`. Indexes are `CREATE INDEX IF NOT EXISTS idx_<table>_<cols> ON <table>(...)` appended after the tables. The new `channels`/`messages` DDL goes inside this same string.

**Row/Public/mapper triple** (`server/src/types.ts`): for each table there is a snake_case `XRow` interface (every column, `number` for booleans with a `// 0 | 1` comment, `T | null` for nullable columns), a camelCase `PublicX` interface (no secret columns; `displayName`/`createdAt` casing), and a `toPublicX(row: XRow): PublicX` pure mapper. Follow this exactly: `ChannelRow`/`PublicChannel` (`createdBy`, `createdAt`) and `MessageRow`/`PublicMessage` (`channelId`, `authorId`, `attachmentId`, `createdAt`).

**Accessor functions**: there is no generic repository layer — query helpers are plain functions that take `db: Db` as their first argument and use prepared statements inline (`db.prepare(sql).get(...) as XRow | undefined` for reads, `.all() as XRow[]` for lists, `.run(...)` for writes). See `authenticateSession` (auth.ts), `buildReady` (gateway.ts, does `SELECT * FROM users WHERE disabled = 0` + `.all() as UserRow[]`). Writes that need the inserted row re-`SELECT` by `lastInsertRowid` (`issueSession`, register handler). `db.transaction(fn)` wraps multi-statement atomic writes (`revokeUser`, register).

**Config tunables** (`server/src/config.ts`): every setting is a field on the `Config` interface plus a line in `loadConfig()` using `num("ENV_NAME", fallback)` for numbers (or `process.env.X ?? "default"` for strings). The canonical env list is mirrored in `server/.env.example`. Existing analogue: `maxUploadMb`, `sessionTtlSeconds`.

**Contract docs**: the M1 `data-and-crypto.md` documents each table as a markdown table (column / type / constraints / notes), then the module API as a fenced `ts` code block with JSDoc, then a "Usage notes for 00x" section telling downstream stories exactly how to call it. Match this structure.

## Data Flow

This story builds the persistence layer that later M2 stories drive; the relevant flows are:

1. **Schema application (every process start):** `index.ts` → `buildApp(config)` (`app.ts`) → `openDatabase(config)` (`db.ts`) → `mkdirSync` + `new Database(...)` + `PRAGMA journal_mode=WAL` + `PRAGMA foreign_keys=ON` + `applySchema(db)`. The CLI (`cli.ts`) opens the same file the same way. Adding `channels`/`messages` to `applySchema` means both entry points converge to the new schema idempotently against an existing M1 db (the `IF NOT EXISTS` guards leave the M1 tables untouched).

2. **Channel create (story 003 will drive):** `POST /api/channels` handler → `createChannel(db, { name, type, createdBy, position })` → `INSERT INTO channels ... VALUES (...)` → re-`SELECT` by `lastInsertRowid` → return `ChannelRow` → handler maps via `toPublicChannel` → response + (story 002) `channel.create` broadcast.

3. **Message send (story 002 will drive):** WS `message.send` frame → gateway validates content/length/channel existence (`getChannelById`) → `insertMessage(db, { channelId, authorId, content, attachmentId: null })` → re-`SELECT` → `MessageRow` → `toPublicMessage` → broadcast `message.create` to all sockets.

4. **History fetch (story 003 will drive):** `GET /api/channels/:id/messages?before=&limit=` → `getChannelById` (404 if missing) → `getChannelMessages(db, channelId, { before, limit })` → keyset query `SELECT * FROM messages WHERE channel_id = ? [AND id < ?] ORDER BY id DESC LIMIT ?` (limit clamped to the config max) → `MessageRow[]` → `toPublicMessage[]`. The `idx_messages_channel_id` index on `(channel_id, id)` serves this query.

5. **ready.channels (story 002 will drive):** gateway `buildReady` will call `listChannels(db)` (`SELECT * FROM channels ORDER BY position, id`) and map to `PublicChannel[]`, replacing the current `channels: []` placeholder.

## Decisions Made

1. **New accessor module `server/src/channels.ts` rather than folding into an existing file.** The story names it explicitly ("e.g. `server/src/channels.ts`"), and the codebase already groups domain helpers by file (`auth.ts`, `crypto.ts`). One module owning channel+message persistence matches the "one source of truth" goal and the M1 layout.

2. **`db: Db` as the first parameter of every accessor** (`getChannelMessages(db, channelId, opts)` is mandated; apply the same to the rest). Mirrors `authenticateSession(db, ...)`; avoids any module-level singleton and keeps these callable from both the REST plugin (`app.db`) and the gateway. No second connection is opened, per the story's explicit instruction.

3. **Write accessors re-`SELECT` the inserted row and return the full `*Row`** (not just the id), following `issueSession`/the register handler. Lets story 002/003 broadcast a complete `message.create` / return a complete `PublicChannel` without a second round-trip in the caller.

4. **Keyset query uses `ORDER BY id DESC LIMIT ?` with the `id < before` predicate only when `before` is provided**, returning newest-first. SPEC §9 specifies keyset pagination on `id` with `before` cursor + `limit` 50; `DESC` is the natural "load latest, page backwards" shape and the `(channel_id, id)` index covers it. The accessor clamps `limit` to `config.messageHistoryMaxLimit` and defaults missing/invalid limits to `config.messageHistoryDefaultLimit`.

5. **Three config tunables:** `maxMessageLength` (`MAX_MESSAGE_LENGTH`, default 4000), `messageHistoryDefaultLimit` (`MSG_HISTORY_DEFAULT_LIMIT`, default 50 per SPEC §9), `messageHistoryMaxLimit` (`MSG_HISTORY_MAX_LIMIT`, default 100). Naming/registration follows the existing `num()` convention. The accessor takes the cap value as part of its options or reads it where called — the plan should decide whether `getChannelMessages` receives the clamp value via its `opts` or the caller pre-clamps; passing the config-derived cap in keeps the accessor pure (recommended: caller passes already-resolved `limit`, OR pass the cap explicitly). Defaults are placeholders the plan can confirm against any SPEC value.

6. **`messages.attachment_id` is a plain `INTEGER` nullable column with NO `FOREIGN KEY` clause.** Per the story + feature spec: under `PRAGMA foreign_keys = ON`, a FK referencing the not-yet-created `attachments` table errors on open. Document the deferral inline in `schema.ts` (and the contract); the FK is added in M3.

7. **Index named `idx_messages_channel_id` on `(channel_id, id)`** — matches the M1 index naming (`idx_<table>_<col>`) and the story's "index on `messages(channel_id, id)`" requirement for keyset pagination.

8. **Leave `ReadyPayload.channels` as `never[]` in this story (do not change to `PublicChannel[]`).** The feature spec assigns `ready.channels` population to story 002 (gateway), and that story's gateway edit will flip the type and call `listChannels`. Touching it here would create a typecheck obligation (the placeholder `channels: []` in `buildReady`) without the consuming logic. The contract will note the `PublicChannel` shape so story 002 can wire it. (If the plan prefers to widen the type now to `PublicChannel[]` and keep `buildReady` returning `[]`, that also typechecks — either is fine; default to not touching it to keep this story purely data-layer.)

## Open Questions

None — all shapes are pinned by SPEC.md §8/§9, the acceptance criteria, and the M1 patterns. Config default values (max message length, page-size cap) have no SPEC-mandated number beyond `limit` 50 (SPEC §9); the chosen defaults are reasonable placeholders the plan/implementer can adjust without structural impact.
