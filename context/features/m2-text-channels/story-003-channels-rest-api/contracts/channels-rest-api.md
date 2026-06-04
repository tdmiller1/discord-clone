#contract

# Contract: Channels REST API — create channel & message history (story 003)

Authoritative interface for the M2 channel REST surface (SPEC.md §9). Client
stories 004 (channel list / create) and 005 (message history) consume these two
endpoints. Builds on M1's Bearer auth (`contracts/auth-api.md`), story 001's data
accessors (`contracts/channels-data.md`), and story 002's `app.broadcast` helper.

All modules are ESM with `.js` import specifiers. Routes are registered inside
`buildApp(config)` (`server/src/app.ts`) via
`void app.register(channelRoutes, { config })`, using the shared `app.db` — no
second DB connection.

## JSON conventions

- Timestamps are **unix epoch milliseconds** (`Date.now()`).
- DB columns are snake_case; API JSON is **camelCase** (`channelId`, `authorId`,
  `createdBy`, `createdAt`, `attachmentId`).
- Booleans / integer flags from the DB never appear in API responses.

## Response shapes

### `PublicChannel`

```jsonc
{
  "id": 1,                  // number
  "name": "general",        // string (trimmed)
  "type": "text",           // "text" | "voice" — M2 only ever creates/returns "text"
  "position": 0,            // number — server-assigned, monotonic append (0-based)
  "createdBy": 1,           // number | null — user id of the creator
  "createdAt": 1780610454376 // number (epoch ms)
}
```

TypeScript (`server/src/types.ts`):

```ts
export interface PublicChannel {
  id: number;
  name: string;
  type: "text" | "voice";
  position: number;
  createdBy: number | null;
  createdAt: number;
}
```

### `PublicMessage`

```jsonc
{
  "id": 42,                  // number
  "channelId": 1,            // number
  "authorId": 3,             // number
  "content": "hello",        // string
  "attachmentId": null,      // number | null — always null in M2
  "createdAt": 1780610454376 // number (epoch ms)
}
```

TypeScript (`server/src/types.ts`):

```ts
export interface PublicMessage {
  id: number;
  channelId: number;
  authorId: number;
  content: string;
  attachmentId: number | null;
  createdAt: number;
}
```

## Endpoint reference

| Method | Path                              | Auth   | Request                                                            | Success              | Error statuses                                                                 |
| ------ | --------------------------------- | ------ | ----------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------ |
| POST   | `/api/channels`                   | Bearer | body `{ name, type: "text" }`                                     | `201` `PublicChannel`| `400` malformed / `400` `channel_name_invalid` / `401` `unauthorized`          |
| GET    | `/api/channels/:id/messages`      | Bearer | path `id`; query `before?`, `limit?`                              | `200` `PublicMessage[]` | `400` malformed / `401` `unauthorized` / `404` `channel_not_found`           |

Both routes require `Authorization: Bearer <raw-session-token>` (M1 scheme,
`contracts/auth-api.md`). Missing/invalid → `401 { "error": "unauthorized" }`.

### `POST /api/channels`

Request:

```jsonc
{
  "name": "general", // string, required, 1..64 chars, non-empty after trim()
  "type": "text"     // string, required, MUST equal "text" (voice is M4)
}
```

Behavior:

1. Validates the Bearer token (`requireAuth`).
2. Trims `name`; the **trimmed** value is what is stored.
3. Assigns `position` server-side (`MAX(position) + 1`, first channel = `0`);
   `position` is never client-supplied.
4. Creates the channel via `createChannel` with `created_by = request.user.id`.
5. Broadcasts `{ "op": "channel.create", "d": { "channel": <PublicChannel> } }`
   to **every** connected, authenticated WS socket — including the creator's own
   socket (no `except`). Clients dedupe by channel `id`.
6. Returns `201` with the `PublicChannel`.

Notes:

- **Duplicate channel names are allowed** (`channels.name` is not UNIQUE).
- `additionalProperties: false`: sending `position`, `createdBy`, or any extra key
  yields `400 { "error": "Bad Request" }`.

Errors:

- `400 { "error": "Bad Request" }` — Fastify schema validation: missing `name`/
  `type`, wrong type, `type !== "text"`, `name` > 64 chars, empty `name`
  (`minLength: 1`), or any unknown property.
- `400 { "error": "channel_name_invalid" }` — `name` is whitespace-only (empty
  after `trim()`); the schema cannot express "non-empty after trim", so the
  handler rejects it.
- `401 { "error": "unauthorized" }` — missing/invalid Bearer.

### `GET /api/channels/:id/messages`

Request:

- Path: `id` — integer ≥ 1 (Fastify coerces the path string; a non-numeric id →
  `400`).
- Query: `before?` — integer ≥ 1 (exclusive keyset cursor); `limit?` — integer
  ≥ 1. Both optional; numeric query strings are coerced to integers.

Example: `GET /api/channels/1/messages?before=42&limit=50`

Behavior:

1. Validates the Bearer token (`requireAuth`).
2. `404 { "error": "channel_not_found" }` if no channel with that id exists
   (checked **before** paging).
3. Returns up to `limit` messages, **newest-first** (`ORDER BY id DESC`).

Returns `200` with a `PublicMessage[]`.

Errors:

- `400 { "error": "Bad Request" }` — non-integer / `< 1` `id`, `before`, or
  `limit`, or any unknown query property.
- `401 { "error": "unauthorized" }` — missing/invalid Bearer.
- `404 { "error": "channel_not_found" }` — unknown channel id.

## Pagination semantics

- **Keyset on `id`.** When `before` is supplied, only rows with `id < before` are
  returned (exclusive cursor); otherwise the latest page is returned.
- **Newest-first.** Rows come back ordered `id DESC`. Clients that render
  oldest→newest must reverse the array for display.
- **Paging backwards.** To fetch the previous page, pass `before = <id of the
  oldest (last) message in the current response>`.
- **`limit`.** Defaults to `50` (`MSG_HISTORY_DEFAULT_LIMIT`) when absent, `0`, or
  non-finite; clamped to the configured cap `100` (`MSG_HISTORY_MAX_LIMIT`) when
  larger.
- **Edge results.** A valid channel with no messages → `200 []`. A `before` cursor
  past the oldest message id → `200 []` (not an error).

## Side effect: `channel.create` WS envelope

`POST /api/channels` emits, over the WS gateway, to all authed sockets:

```jsonc
{ "op": "channel.create", "d": { "channel": <PublicChannel> } }
```

Typed as `ChannelCreatePayload` in `server/src/types.ts`. The creator's own socket
receives it too; downstream clients dedupe by `channel.id`.
