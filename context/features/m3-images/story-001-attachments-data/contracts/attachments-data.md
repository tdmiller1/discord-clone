#contract

# Contract: Attachments data layer (story 001)

Authoritative interface for the server attachment persistence + message-embedding layer. Stories 002
(upload REST endpoint), 003 (gateway link flow), and 005 (client rendering) build on exactly what is
documented here. Source of truth for the data model is `SPEC.md §8`; for allowed image types, the
`DATA_DIR/images/<id>` storage path, and inline rendering, `SPEC.md §10`.

All modules are ESM with `.js` import specifiers (e.g. `import { createAttachment } from "./attachments.js"`).
Files live under `server/src/`. Accessors use the shared `Db` handle (`fastify.db` / the gateway db) —
do **not** open a second connection.

## Tables

Created idempotently on every `openDatabase` (`CREATE TABLE/INDEX IF NOT EXISTS`), alongside the
M1/M2 tables. Conventions: `id INTEGER PRIMARY KEY AUTOINCREMENT`; timestamps are **unix epoch
milliseconds** (`Date.now()`); foreign keys are enforced (`PRAGMA foreign_keys = ON`).

### attachments

| column         | type    | constraints                  | notes                                                           |
| -------------- | ------- | ---------------------------- | --------------------------------------------------------------- |
| `id`           | INTEGER | PRIMARY KEY AUTOINCREMENT    | the attachment id the client resolves to `GET /api/attachments/:id` |
| `message_id`   | INTEGER | nullable, FK → `messages(id)` | NULL until linked to a message; set **once** via `linkAttachmentToMessage` |
| `uploader_id`  | INTEGER | NOT NULL, FK → `users(id)`   | the user who uploaded; ownership is validated against this (story 003) |
| `filename`     | TEXT    | NOT NULL                     | original client filename                                        |
| `content_type` | TEXT    | NOT NULL                     | MIME type (validated by the upload route, story 002)            |
| `size`         | INTEGER | NOT NULL                     | byte size                                                       |
| `width`        | INTEGER | nullable                     | image width in px (NULL if unknown)                             |
| `height`       | INTEGER | nullable                     | image height in px (NULL if unknown)                            |
| `path`         | TEXT    | NOT NULL                     | on-disk path under `DATA_DIR/images/<id>` (story 002 owns disk) |
| `created_at`   | INTEGER | NOT NULL                     | epoch ms                                                        |

Index: `idx_attachments_message_id` on `(message_id)`.

### messages — `attachment_id` FK (now declared)

The canonical `messages` `CREATE TABLE` now declares `FOREIGN KEY (attachment_id) REFERENCES attachments(id)`.
SQLite resolves FK targets lazily within a single `db.exec`, so the forward reference (`messages`
defined before `attachments`) is valid on a fresh deploy.

**Pre-existing M2 database note:** on a database created under M2, `CREATE TABLE IF NOT EXISTS messages`
is a no-op, so the new FK is **not** retro-applied (SQLite cannot `ALTER … ADD CONSTRAINT`). The
column stays FK-less there. Referential integrity for the message↔attachment link is therefore
enforced in the accessor/gateway layer: `linkAttachmentToMessage`'s link-once `WHERE message_id IS NULL`
guard plus story 003's uploader-ownership and existence checks.

## attachments module API (`server/src/attachments.ts`)

```ts
import type { Db } from "./db.js";
import type { AttachmentRow } from "./types.js";

/**
 * Inserts an unlinked attachment (`message_id` NULL, `created_at = Date.now()`)
 * and returns the persisted row (re-SELECTed by lastInsertRowid). The caller
 * writes the file to disk (story 002); this only records the row.
 */
export function createAttachment(
  db: Db,
  input: {
    uploaderId: number;
    filename: string;
    contentType: string;
    size: number;
    width: number | null;
    height: number | null;
    path: string;
  },
): AttachmentRow;

/** Looks up a single attachment by id, or `undefined` if it does not exist. */
export function getAttachmentById(db: Db, id: number): AttachmentRow | undefined;

/**
 * Links an attachment to a message exactly once: sets `attachments.message_id`
 * only while it is still NULL. Returns `true` when applied, `false` when the
 * attachment is already linked (or does not exist). The caller validates uploader
 * ownership before calling.
 */
export function linkAttachmentToMessage(
  db: Db,
  attachmentId: number,
  messageId: number,
): boolean;
```

### Link-once semantics

`linkAttachmentToMessage` runs `UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL`
and returns `info.changes === 1`. Consequences callers rely on:

- An attachment can be linked to **at most one** message, ever. A second link attempt (same or
  different message) matches 0 rows and returns `false` — never double-attaches, even under concurrency.
- A non-existent `attachmentId` returns `false`.
- The function does **not** check uploader ownership or message existence; story 003 must call
  `getAttachmentById` first to confirm the attachment exists, belongs to the message author
  (`uploader_id === authorId`), and is still unlinked (`message_id === null`) before inserting the
  message and linking.

## Row & public JSON shapes (`server/src/types.ts`)

Row shape (snake_case, what `.get()`/`.all()` are cast to):

```ts
interface AttachmentRow {
  id: number;
  message_id: number | null;
  uploader_id: number;
  filename: string;
  content_type: string;
  size: number;
  width: number | null;
  height: number | null;
  path: string;
  created_at: number; // epoch ms
}
```

Public JSON shape (camelCase, what goes over the wire) + pure mapper:

```ts
interface PublicAttachment {
  id: number;            // client resolves the bytes via GET /api/attachments/:id
  messageId: number | null;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  createdAt: number;
}
function toPublicAttachment(row: AttachmentRow): PublicAttachment;
```

**No baked URL.** `PublicAttachment` deliberately exposes `id`, not a `url`. The download is
auth-checked (Bearer token), so the client builds `GET /api/attachments/:id` from `id` itself and
fetches the bytes into an object URL (SPEC §10). The data layer has no base-URL config to bake.

## Message embedding

`PublicMessage` now embeds the attachment in place of the old inert `attachmentId`:

```ts
interface PublicMessage {
  id: number;
  channelId: number;
  authorId: number;
  content: string;
  attachment: PublicAttachment | null; // replaces `attachmentId`
  createdAt: number;
}

// Two-arg signature — second arg is the separately-read/joined attachment row (or null):
function toPublicMessage(row: MessageRow, attachment: AttachmentRow | null): PublicMessage;
```

`toPublicMessage` returns `attachment: attachment ? toPublicAttachment(attachment) : null`. All
callers were updated to pass the second arg.

### Read-side accessors (`server/src/channels.ts`)

`getChannelMessages` (history) and `getMessageWithAttachment` (single-message, gateway parity) both
`LEFT JOIN attachments a ON a.id = m.attachment_id` and return message+attachment pairs in one
round-trip (no N+1):

```ts
import type { Db } from "./db.js";

type MessageWithAttachment = { message: MessageRow; attachment: AttachmentRow | null };

// Keyset history page, newest-first; attachment embedded per row (null when none).
function getChannelMessages(
  db: Db,
  channelId: number,
  opts: { before?: number; limit: number },
): MessageWithAttachment[];

// Single message + its embedded attachment, same LEFT JOIN parity as history.
function getMessageWithAttachment(db: Db, id: number): MessageWithAttachment | undefined;
```

Map each pair to the wire shape with `toPublicMessage(r.message, r.attachment)`.

## Configuration

**No new config this story.** `MAX_UPLOAD_MB` (`config.maxUploadMb`) and `DATA_DIR` (`config.dataDir`)
already exist and are reused as-is — do not re-read env ad hoc. The allowed-MIME list and the
`DATA_DIR/images` subpath are added by story 002 (which owns upload validation and disk writes).

## Usage notes for 002 / 003 / 005

- **Upload REST (002):** validate MIME (allowed-image list it adds to `config`) and size against
  `config.maxUploadMb`; write bytes to `DATA_DIR/images/<id>`; call
  `createAttachment(db, { uploaderId, filename, contentType, size, width, height, path })`; respond
  with `{ attachmentId: row.id }`. The row starts `message_id` NULL (unlinked).
- **Gateway link (003):** on `message.send` with `attachmentId`:
  1. `getAttachmentById(db, attachmentId)` → must exist, `uploader_id === authorId`, `message_id === null`.
  2. `insertMessage(db, { ..., attachmentId: null })` (the FK column on the message stays optional; the
     authoritative link is the attachment's `message_id`).
  3. `linkAttachmentToMessage(db, attachmentId, message.id)` → must return `true`.
  4. Broadcast `message.create` via `getMessageWithAttachment(db, message.id)` mapped with
     `toPublicMessage(r.message, r.attachment)` so the live event carries the linked attachment
     identically to history. (This story currently broadcasts `toPublicMessage(row, null)`; 003 flips
     this to the linked read.)
  - If any check fails, reject/ignore per 003's error policy; do not link.
- **Client rendering (005):** read `message.attachment` (a `PublicAttachment | null`); when present,
  fetch the image from `GET /api/attachments/:id` with the Bearer token into an object URL and render
  inline using `width`/`height` for layout. There is no `url` field — build the path from `id`.
- Reach the db via `fastify.db` (or the gateway's handle); never open a second connection.
