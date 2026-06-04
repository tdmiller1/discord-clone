#contract

# Contract: Channels & messages data layer (story 001)

Authoritative interface for the server channel/message persistence layer. Stories 002 (WS gateway)
and 003 (REST API) build on exactly what is documented here. Source of truth for the data model is
`SPEC.md §8`; for ordering and history pagination, `SPEC.md §9`.

All modules are ESM with `.js` import specifiers (e.g. `import { listChannels } from "./channels.js"`).
Files live under `server/src/`. Accessors use the shared `Db` handle (`fastify.db` / the gateway db) —
do **not** open a second connection.

## Tables

Created idempotently on every `openDatabase` (`CREATE TABLE/INDEX IF NOT EXISTS`), alongside the M1
tables. Conventions: `id INTEGER PRIMARY KEY AUTOINCREMENT`; timestamps are **unix epoch
milliseconds** (`Date.now()`); foreign keys are enforced (`PRAGMA foreign_keys = ON`).

The `attachments` table is NOT created here (deferred to M3).

### channels

| column       | type    | constraints                                | notes                                                  |
| ------------ | ------- | ------------------------------------------ | ------------------------------------------------------ |
| `id`         | INTEGER | PRIMARY KEY AUTOINCREMENT                   |                                                        |
| `name`       | TEXT    | NOT NULL                                   |                                                        |
| `type`       | TEXT    | NOT NULL, `CHECK (type IN ('text','voice'))` | only `text`/`voice`; M2 create route rejects `voice` (voice arrives M4) |
| `position`   | INTEGER | NOT NULL                                   | sort key; `listChannels` orders by this then `id`      |
| `created_by` | INTEGER | nullable, FK → `users(id)`                 | null reserved for future system-seeded channels        |
| `created_at` | INTEGER | NOT NULL                                   | epoch ms                                               |

### messages

| column          | type    | constraints                   | notes                                                                 |
| --------------- | ------- | ----------------------------- | --------------------------------------------------------------------- |
| `id`            | INTEGER | PRIMARY KEY AUTOINCREMENT      | monotonic; the ordering + keyset-pagination key (SPEC §9)             |
| `channel_id`    | INTEGER | NOT NULL, FK → `channels(id)` |                                                                       |
| `author_id`     | INTEGER | NOT NULL, FK → `users(id)`    |                                                                       |
| `content`       | TEXT    | NOT NULL                      | plain text (SPEC §9)                                                  |
| `attachment_id` | INTEGER | nullable, **NO FK**           | the `attachments` table is M3; a FK to a missing table errors under `foreign_keys = ON`, so the FK is deferred to M3. Always `NULL` in M2. |
| `created_at`    | INTEGER | NOT NULL                      | epoch ms                                                              |

Index: `idx_messages_channel_id` on `(channel_id, id)` — covers the keyset history query.

## channels module API (`server/src/channels.ts`)

```ts
import type { Db } from "./db.js";
import type { ChannelRow, MessageRow } from "./types.js";

/** Inserts a channel and returns the persisted row (re-SELECTed by lastInsertRowid). */
export function createChannel(
  db: Db,
  input: { name: string; type: "text" | "voice"; position: number; createdBy: number | null },
): ChannelRow;

/** Looks up a single channel by id, or `undefined` if it does not exist. */
export function getChannelById(db: Db, id: number): ChannelRow | undefined;

/** Lists every channel, ordered by `position` then `id`. */
export function listChannels(db: Db): ChannelRow[];

/** Inserts a message and returns the persisted row (re-SELECTed by lastInsertRowid). */
export function insertMessage(
  db: Db,
  input: { channelId: number; authorId: number; content: string; attachmentId: number | null },
): MessageRow;

/**
 * Keyset history page for a channel, newest-first (ORDER BY id DESC). When `before`
 * is a finite number, only rows with `id < before` are returned. `limit` is used
 * as-given (callers clamp via clampHistoryLimit first).
 */
export function getChannelMessages(
  db: Db,
  channelId: number,
  opts: { before?: number; limit: number },
): MessageRow[];

/**
 * Resolves a requested page size: undefined / non-finite / <= 0 → `defaultLimit`;
 * otherwise `Math.min(requested, maxLimit)`. Use before getChannelMessages.
 */
export function clampHistoryLimit(
  requested: number | undefined,
  opts: { defaultLimit: number; maxLimit: number },
): number;
```

## Pagination semantics (SPEC §9)

- History is keyset-paginated on `messages.id` (no OFFSET).
- `getChannelMessages` returns rows **newest-first** (`ORDER BY id DESC`). Consumers that render
  oldest→newest reverse the array client-side.
- `before` is an **exclusive** cursor: passing the oldest already-loaded message id returns the next
  older page (`id < before`). Omitting `before` returns the newest page. A `before` older than every
  message yields an empty array.
- `limit` is trusted by `getChannelMessages`; the caller resolves it first via `clampHistoryLimit`,
  which maps a missing/invalid `?limit=` to `config.messageHistoryDefaultLimit` (default `50`) and
  caps any larger request at `config.messageHistoryMaxLimit` (default `100`).

## Row & public JSON shapes (`server/src/types.ts`)

Row shapes (snake_case, what `.get()`/`.all()` are cast to):

```ts
interface ChannelRow {
  id: number;
  name: string;
  type: "text" | "voice";
  position: number;
  created_by: number | null;
  created_at: number; // epoch ms
}

interface MessageRow {
  id: number;
  channel_id: number;
  author_id: number;
  content: string;
  attachment_id: number | null; // always null in M2 (attachments are M3)
  created_at: number; // epoch ms
}
```

Public JSON shapes (camelCase, what goes over the wire) + pure mappers:

```ts
interface PublicChannel {
  id: number;
  name: string;
  type: "text" | "voice";
  position: number;
  createdBy: number | null;
  createdAt: number;
}
function toPublicChannel(row: ChannelRow): PublicChannel;

interface PublicMessage {
  id: number;
  channelId: number;
  authorId: number;
  content: string;
  attachmentId: number | null; // always null in M2
  createdAt: number;
}
function toPublicMessage(row: MessageRow): PublicMessage;
```

## Configuration

Tunables added to `loadConfig()` (`server/src/config.ts`) + `server/.env.example`:

| Config field                 | Env var                    | Default | Notes                                    |
| ---------------------------- | -------------------------- | ------- | ---------------------------------------- |
| `maxMessageLength`           | `MAX_MESSAGE_LENGTH`       | `4000`  | gateway validates `content.length` ≤ this |
| `messageHistoryDefaultLimit` | `MSG_HISTORY_DEFAULT_LIMIT`| `50`    | SPEC §9 default page size                |
| `messageHistoryMaxLimit`     | `MSG_HISTORY_MAX_LIMIT`    | `100`   | clamp ceiling for `?limit=`              |

## Usage notes for 002 / 003

- **WS gateway (002):**
  - Flip `ReadyPayload.channels` from `never[]` to `PublicChannel[]` and populate `buildReady` via
    `listChannels(db).map(toPublicChannel)` (currently returns `channels: []`).
  - On `message.send`: validate `content` is non-empty and `content.length <= config.maxMessageLength`;
    confirm the channel exists with `getChannelById(db, channelId)`; then
    `insertMessage(db, { channelId, authorId, content, attachmentId: null })` — **pass `null`**
    (attachments are M3); map the returned row with `toPublicMessage` and broadcast `message.create`.
- **REST API (003):**
  - `POST /api/channels`: choose a `position`, call `createChannel(db, { name, type, position, createdBy })`,
    respond with `toPublicChannel(row)`. (Story 002 also broadcasts `channel.create`.)
  - `GET /api/channels/:id/messages?before=&limit=`: `getChannelById` → 404 if missing; resolve the
    page size with `clampHistoryLimit(limit, { defaultLimit: config.messageHistoryDefaultLimit, maxLimit: config.messageHistoryMaxLimit })`;
    call `getChannelMessages(db, id, { before, limit })`; map with `toPublicMessage`. Results are
    newest-first — document/reverse for the client as needed.
- Reach the db via `fastify.db` (or the gateway's handle); never open a second connection.
