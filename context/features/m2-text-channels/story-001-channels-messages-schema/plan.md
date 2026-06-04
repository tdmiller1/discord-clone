#plan

# Plan: Server data layer — channels & messages

## Summary
Extend the M1 SQLite schema with idempotent `channels` and `messages` tables (exactly per `SPEC.md §8`) plus a keyset index, add row/public types + pure mappers to `types.ts`, introduce three config tunables, and create a new `server/src/channels.ts` accessor module (`createChannel`, `getChannelById`, `listChannels`, `insertMessage`, `getChannelMessages`) that becomes the single source of truth the gateway (story 002) and REST API (story 003) build on. This is a pure data-layer story: no routes, no gateway wiring, no broadcast logic.

All `research.md` "Decisions Made" are treated as final and adopted as-is. Notable resolutions confirmed against the code while planning:
- **`ReadyPayload.channels` is left as `never[]`** (Decision 8). Verified at `server/src/ws/gateway.ts:84` that `buildReady` returns `channels: []`, which still typechecks against `never[]`; flipping the type to `PublicChannel[]` here would force a `buildReady` edit that belongs to story 002. The contract documents `PublicChannel` so story 002 can flip it.
- **`getChannelMessages` receives a pre-resolved, already-clamped `limit`** in its `opts` and applies no config-derived cap itself (Decision 5, "caller pre-clamps" option). This keeps the accessor pure and config-free, matching the `db`-first, framework-agnostic style of `authenticateSession`. The clamp helper is exported alongside it so callers (stories 002/003) resolve the limit consistently. Defaults: `MAX_MESSAGE_LENGTH=4000`, `MSG_HISTORY_DEFAULT_LIMIT=50` (per SPEC §9), `MSG_HISTORY_MAX_LIMIT=100`.
- **`messages.attachment_id` is a plain nullable `INTEGER` with NO `FOREIGN KEY` clause** (Decision 6) because `PRAGMA foreign_keys = ON` errors on a FK to the not-yet-created `attachments` table (M3). The deferral is documented inline in `schema.ts` and in the contract.

## Implementation Steps

### Step 1: Add channel/message config tunables
**File(s):** `server/src/config.ts`
**Action:** modify
**Description:** Add the three message/history tunables to the `Config` interface and populate them in `loadConfig()` via the existing `num()` helper, so the accessor cap and gateway length-validation read from config rather than `process.env`. These have no SPEC-mandated value except history `limit` 50 (SPEC §9); the others are sane defaults.
**Diff shape:**
- Add (to `Config` interface): `maxMessageLength: number;` (`/** Max accepted message content length, in characters. */`), `messageHistoryDefaultLimit: number;` (`/** Default page size for message history when no limit is supplied. */`), `messageHistoryMaxLimit: number;` (`/** Hard cap on the message-history page size; larger requests are clamped. */`).
- Add (to the `loadConfig()` return object, after `authRateWindowMs`): `maxMessageLength: num("MAX_MESSAGE_LENGTH", 4000),`, `messageHistoryDefaultLimit: num("MSG_HISTORY_DEFAULT_LIMIT", 50),`, `messageHistoryMaxLimit: num("MSG_HISTORY_MAX_LIMIT", 100),`.
- Change: nothing else.

### Step 2: Document the new env vars
**File(s):** `server/.env.example`
**Action:** modify
**Description:** Mirror the three new tunables in the example env file with their defaults and a short comment, keeping `.env.example` the canonical env list (per CLAUDE.md and SPEC §12).
**Diff shape:**
- Add (appended after the auth rate-limit block):
  ```
  # Text channels / message history (M2). Optional; defaults below.
  MAX_MESSAGE_LENGTH=4000
  MSG_HISTORY_DEFAULT_LIMIT=50
  MSG_HISTORY_MAX_LIMIT=100
  ```
- Remove / Change: nothing.

### Step 3: Extend the schema with `channels` and `messages`
**File(s):** `server/src/schema.ts`
**Action:** modify
**Description:** Append `CREATE TABLE IF NOT EXISTS channels` and `CREATE TABLE IF NOT EXISTS messages` plus the keyset index to the existing `SCHEMA_SQL` string, exactly per SPEC §8 — without touching the M1 tables. Update the module doc comment (currently "`channels`/`messages`/`attachments` are deferred to M2/M3") to reflect that `channels`/`messages` now exist and only `attachments` is deferred (M3). Document inline why `attachment_id` carries no FK.
**Diff shape:**
- Add (to `SCHEMA_SQL`, after the `sessions` table and before the existing `CREATE INDEX` lines, or after them — placement inside the same template is what matters):
  ```sql
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('text','voice')),
    position INTEGER NOT NULL,
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    author_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    -- attachment_id: nullable, NO FOREIGN KEY. The `attachments` table is M3;
    -- under PRAGMA foreign_keys = ON a FK to a missing table errors on open.
    -- The FK is added when `attachments` lands (M3).
    attachment_id INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (channel_id) REFERENCES channels(id),
    FOREIGN KEY (author_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id, id);
  ```
- Change: update the JSDoc block at the top of the file from "deferred to M2/M3" to note `channels`/`messages` are now created here (M2) and only `attachments` remains deferred (M3); keep the timestamp/boolean conventions note.
- Remove: nothing.

### Step 4: Add `ChannelRow`/`MessageRow` row types
**File(s):** `server/src/types.ts`
**Action:** modify
**Description:** Add the two snake_case row interfaces mirroring the new tables exactly (nullable columns as `T | null`), following the `UserRow`/`SessionRow`/`InviteTokenRow` template. These are the single place better-sqlite3 `.get()`/`.all()` results are cast for the new tables.
**Diff shape:**
- Add (after `InviteTokenRow`):
  ```ts
  export interface ChannelRow {
    id: number;
    name: string;
    type: "text" | "voice";
    position: number;
    created_by: number | null;
    created_at: number;
  }

  export interface MessageRow {
    id: number;
    channel_id: number;
    author_id: number;
    content: string;
    attachment_id: number | null;
    created_at: number;
  }
  ```

### Step 5: Add `PublicChannel`/`PublicMessage` types + mappers
**File(s):** `server/src/types.ts`
**Action:** modify
**Description:** Add the camelCase public API shapes and the pure `toPublicChannel`/`toPublicMessage` mappers, mirroring the `PublicUser`/`toPublicUser` pattern. These are the JSON shapes stories 002/003 emit over the wire (`ready.channels`, `channel.create`, `message.create`, history responses).
**Diff shape:**
- Add (after `toPublicUser`):
  ```ts
  /** A channel as returned to clients (ready.channels, channel.create, REST). */
  export interface PublicChannel {
    id: number;
    name: string;
    type: "text" | "voice";
    position: number;
    createdBy: number | null;
    createdAt: number;
  }

  export function toPublicChannel(row: ChannelRow): PublicChannel {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      position: row.position,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  /** A message as returned to clients (message.create, history fetch). */
  export interface PublicMessage {
    id: number;
    channelId: number;
    authorId: number;
    content: string;
    attachmentId: number | null;
    createdAt: number;
  }

  export function toPublicMessage(row: MessageRow): PublicMessage {
    return {
      id: row.id,
      channelId: row.channel_id,
      authorId: row.author_id,
      content: row.content,
      attachmentId: row.attachment_id,
      createdAt: row.created_at,
    };
  }
  ```
- Change: leave `ReadyPayload.channels: never[]` untouched (Decision 8). Optionally add a `// will become PublicChannel[] in story 002` comment next to it for clarity (non-functional).

### Step 6: Create the `channels.ts` accessor module
**File(s):** `server/src/channels.ts`
**Action:** create
**Description:** New module owning all channel + message persistence, built on the `Db` handle (`db` as first arg of every accessor, mirroring `authenticateSession`). No second connection is opened; callers pass `app.db` / the gateway db. Write accessors re-`SELECT` the inserted row by `lastInsertRowid` and return the full `*Row` (Decision 3), so callers can map to the public shape and broadcast without a second round-trip. Reads cast inline (`as XRow | undefined` / `as XRow[]`). Includes a small exported `clampHistoryLimit` helper so callers resolve the page size consistently against config; `getChannelMessages` itself takes the already-resolved `limit` and stays config-free (Decision 5).
**Diff shape:**
- Add: ESM module with `.js` import specifiers. Imports: `import type { Db } from "./db.js";` and `import type { ChannelRow, MessageRow } from "./types.js";`.
- Add `createChannel(db, input)` — `input: { name: string; type: "text" | "voice"; position: number; createdBy: number | null }`; `INSERT INTO channels (...) VALUES (?, ?, ?, ?, ?)` with `created_at = Date.now()`; re-`SELECT * FROM channels WHERE id = ?` by `Number(insert.lastInsertRowid)`; return `ChannelRow`.
- Add `getChannelById(db, id)` — `SELECT * FROM channels WHERE id = ?` → `ChannelRow | undefined`.
- Add `listChannels(db)` — `SELECT * FROM channels ORDER BY position, id` → `ChannelRow[]`.
- Add `insertMessage(db, input)` — `input: { channelId: number; authorId: number; content: string; attachmentId: number | null }`; `INSERT INTO messages (channel_id, author_id, content, attachment_id, created_at) VALUES (?, ?, ?, ?, ?)` with `created_at = Date.now()`; re-`SELECT * FROM messages WHERE id = ?`; return `MessageRow`.
- Add `getChannelMessages(db, channelId, { before?, limit })` — keyset query `SELECT * FROM messages WHERE channel_id = ?` + (when `before` is a finite number) ` AND id < ?` + ` ORDER BY id DESC LIMIT ?`; `limit` is used as-given (caller pre-clamps); returns `MessageRow[]`, newest-first. The `(channel_id, id)` index covers this.
- Add `clampHistoryLimit(requested, { defaultLimit, maxLimit })` — returns `defaultLimit` when `requested` is undefined/non-finite/≤0, otherwise `Math.min(requested, maxLimit)`. Exported so the REST handler (003) resolves `?limit=` consistently.
- Add module JSDoc naming this the single source of truth for channel/message persistence, consumed by stories 002 (gateway) and 003 (REST).

### Step 7: Write the contract `channels-data.md`
**File(s):** `context/features/m2-text-channels/story-001-channels-messages-schema/contracts/channels-data.md`
**Action:** create
**Description:** Document the two new tables (markdown column tables), the `channels.ts` accessor API (fenced `ts` block with JSDoc signatures), the keyset pagination semantics (`before` cursor, newest-first `DESC`, clamp behavior, default/max from config), the `PublicChannel`/`PublicMessage` JSON shapes, and a "Usage notes for 002/003" section telling each downstream story exactly how to call it (including that story 002 flips `ReadyPayload.channels` to `PublicChannel[]` via `listChannels` + `toPublicChannel`, and that `attachment_id` is always `NULL` in M2). Mirror the structure of the M1 `data-and-crypto.md`. Note `contracts/` must be created (the `mkdir -p` is implicit in writing the file).
**Diff shape:**
- Add: `#contract` header, table docs (`channels`, `messages` with the `attachment_id` no-FK deferral note + the `idx_messages_channel_id` index), accessor API code block, pagination semantics, public JSON shapes, usage notes.

## New Types / Schemas / Contracts

Row shapes (snake_case, `server/src/types.ts`):
```ts
ChannelRow {
  id: number;
  name: string;
  type: "text" | "voice";
  position: number;
  created_by: number | null;
  created_at: number;          // epoch ms
}

MessageRow {
  id: number;
  channel_id: number;
  author_id: number;
  content: string;
  attachment_id: number | null; // nullable, no enforced FK (attachments table is M3)
  created_at: number;          // epoch ms
}
```

Public API shapes (camelCase, `server/src/types.ts`):
```ts
PublicChannel {
  id: number;
  name: string;
  type: "text" | "voice";
  position: number;
  createdBy: number | null;
  createdAt: number;
}

PublicMessage {
  id: number;
  channelId: number;
  authorId: number;
  content: string;
  attachmentId: number | null;
  createdAt: number;
}

toPublicChannel(row: ChannelRow): PublicChannel
toPublicMessage(row: MessageRow): PublicMessage
```

Accessor API (`server/src/channels.ts`):
```ts
createChannel(db: Db, input: {
  name: string; type: "text" | "voice"; position: number; createdBy: number | null;
}): ChannelRow

getChannelById(db: Db, id: number): ChannelRow | undefined

listChannels(db: Db): ChannelRow[]              // ORDER BY position, id

insertMessage(db: Db, input: {
  channelId: number; authorId: number; content: string; attachmentId: number | null;
}): MessageRow

getChannelMessages(db: Db, channelId: number, opts: {
  before?: number;   // exclusive: returns rows with id < before
  limit: number;     // already clamped by the caller (see clampHistoryLimit)
}): MessageRow[]                                  // newest-first (ORDER BY id DESC)

clampHistoryLimit(requested: number | undefined, opts: {
  defaultLimit: number; maxLimit: number;
}): number
```

## Configuration / Environment Changes

| Setting (Config) | Env var | Default | Registered in |
| ---------------- | ------- | ------- | ------------- |
| `maxMessageLength` | `MAX_MESSAGE_LENGTH` | `4000` | `config.ts` `Config` + `loadConfig()` (via `num()`), `.env.example` |
| `messageHistoryDefaultLimit` | `MSG_HISTORY_DEFAULT_LIMIT` | `50` (SPEC §9) | same |
| `messageHistoryMaxLimit` | `MSG_HISTORY_MAX_LIMIT` | `100` | same |

Persisted schema additions (`server/src/schema.ts`, idempotent `CREATE ... IF NOT EXISTS`):
- Table `channels` — columns `id, name, type, position, created_by, created_at`; `CHECK (type IN ('text','voice'))`; FK `created_by → users(id)`.
- Table `messages` — columns `id, channel_id, author_id, content, attachment_id, created_at`; FKs `channel_id → channels(id)`, `author_id → users(id)`; **no FK on `attachment_id`** (M3 deferral).
- Index `idx_messages_channel_id` on `messages(channel_id, id)`.

## API / Interface Changes

No externally-consumed HTTP/WS surface is added in this story (routes and gateway ops arrive in stories 002/003). The surfaces introduced here are internal module exports + the persisted schema:

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| Persisted table | `channels` | — | — | New, idempotent; per SPEC §8 |
| Persisted table | `messages` | — | — | New, idempotent; `attachment_id` no FK (M3) |
| Persisted index | `idx_messages_channel_id` | — | — | `(channel_id, id)`; serves keyset history |
| Module fn | `createChannel(db, input)` | `{name,type,position,createdBy}` | `ChannelRow` | re-SELECTs inserted row |
| Module fn | `getChannelById(db, id)` | `id` | `ChannelRow \| undefined` | |
| Module fn | `listChannels(db)` | — | `ChannelRow[]` | `ORDER BY position, id` |
| Module fn | `insertMessage(db, input)` | `{channelId,authorId,content,attachmentId}` | `MessageRow` | `attachmentId` stored as-is (NULL in M2) |
| Module fn | `getChannelMessages(db, channelId, opts)` | `{before?, limit}` | `MessageRow[]` (DESC) | keyset on `id`; caller pre-clamps `limit` |
| Module fn | `clampHistoryLimit(requested, opts)` | `requested, {defaultLimit, maxLimit}` | `number` | shared clamp for 003 |
| Mapper | `toPublicChannel(row)` | `ChannelRow` | `PublicChannel` | pure |
| Mapper | `toPublicMessage(row)` | `MessageRow` | `PublicMessage` | pure |

## Edge Cases & Gotchas

- **FK to a missing table errors on open** — `messages.attachment_id` must NOT carry a `FOREIGN KEY` clause; with `PRAGMA foreign_keys = ON` a FK to the M3-only `attachments` table would error every `openDatabase`. Handled in Step 3 (no FK + inline comment).
- **Idempotency / coexistence with M1 db** — all DDL is `CREATE TABLE/INDEX IF NOT EXISTS`; running against an existing M1 db leaves `users`/`invite_tokens`/`sessions` untouched and re-running is a no-op. Handled in Step 3.
- **`type` constraint** — only `'text'`/`'voice'` accepted via `CHECK`; the M2 create route (story 003) further rejects `voice`, but the column supports it (voice arrives M4). Handled in Step 3.
- **`created_by` nullable** — supports future system-seeded channels; FK still references `users(id)` so a non-null value must be a real user. Handled in Steps 3/4.
- **Keyset pagination cursor** — `getChannelMessages` only adds `AND id < ?` when `before` is a finite number; a missing/undefined `before` returns the newest page; a `before` past the oldest message yields an empty list naturally. Handled in Step 6.
- **Limit clamping** — `getChannelMessages` trusts its `limit`; the `clampHistoryLimit` helper (used by callers) maps undefined/non-finite/≤0 → `defaultLimit` and caps at `maxLimit`, so an oversized `?limit=` is clamped and a missing one defaults to 50. Handled in Step 6.
- **Newest-first ordering** — query is `ORDER BY id DESC`; downstream (client, story 005) reverses for display. Documented in the contract (Step 7) so consumers know the order.
- **`attachmentId` ignored in M2** — `insertMessage` accepts `attachmentId` but story 002 passes `null`; the column stores whatever is passed, so the gateway must pass `null` (noted in contract usage notes). Handled in Steps 6/7.
- **`ReadyPayload.channels` left as `never[]`** — `buildReady` still returns `[]` (verified `gateway.ts:84`), which typechecks; story 002 flips the type. No change here avoids an orphaned typecheck obligation. Handled by Decision 8 (Step 5 leaves it untouched).
- **ESM `.js` import specifiers** — `channels.ts` imports `./db.js` / `./types.js`; required by NodeNext. Handled in Step 6.
- **Re-SELECT after insert** — `lastInsertRowid` is a bigint; wrap in `Number(...)` before the re-SELECT (matches `issueSession`/register). Handled in Step 6.

## Acceptance Criteria Checklist

- [ ] `applySchema` extended to idempotently create `channels` + `messages` exactly per SPEC §8 without disturbing M1 tables → Step 3
- [ ] `channels` columns/types/constraints (`id` PK AUTOINCREMENT, `name` NOT NULL, `type` NOT NULL + CHECK text/voice, `position` NOT NULL, `created_by` nullable FK→users, `created_at` NOT NULL) → Step 3
- [ ] `messages` columns/types (`id` PK AUTOINCREMENT, `channel_id` NOT NULL FK→channels, `author_id` NOT NULL FK→users, `content` NOT NULL, `attachment_id` nullable NO FK + documented deferral, `created_at` NOT NULL) → Step 3
- [ ] Index on `messages(channel_id, id)` for keyset pagination → Step 3
- [ ] Accessor module exports `createChannel`, `getChannelById`, `listChannels` (ORDER BY position, id), `insertMessage`, `getChannelMessages` (keyset `id < before`, newest-first, clamped limit) on the `Db` handle → Step 6 (clamp via `clampHistoryLimit`, Step 6 + Config Steps 1/2)
- [ ] Row + public JSON types in `types.ts`: `ChannelRow`/`MessageRow` (snake_case) and `PublicChannel`/`PublicMessage` (camelCase: `channelId`, `authorId`, `attachmentId`, `createdAt`) → Steps 4, 5
- [ ] New tunables (max message length, default/max history page size) added to `loadConfig()` + `.env.example` → Steps 1, 2
- [ ] `npm run typecheck` passes; starting against an existing M1 db creates the tables without error; re-running is idempotent → Steps 3, 6 (verified by typecheck + `sqlite3` inspection at validation)
- [ ] `contracts/channels-data.md` documents tables, accessor API, pagination semantics, and `PublicChannel`/`PublicMessage` JSON for stories 002/003 → Step 7
