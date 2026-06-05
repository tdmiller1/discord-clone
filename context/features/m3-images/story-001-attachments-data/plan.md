#plan

# Plan: Server data layer — attachments table, accessors & message embedding

## Summary
Add the SQLite `attachments` table (per `SPEC.md §8`) and its `message_id` index in `schema.ts`, declare the previously-deferred `messages.attachment_id` → `attachments(id)` FK, introduce a framework-agnostic `attachments.ts` accessor module (`createAttachment`, `getAttachmentById`, `linkAttachmentToMessage` with link-once semantics), and extend the type layer so every `PublicMessage` embeds `attachment: PublicAttachment | null` — wiring the read/embed path through `getChannelMessages`, the history route, and the gateway broadcast (value always `null` this story; stories 002/003 fill it in).

Decisions carried from research (all confirmed):
- **Embedding via LEFT JOIN** in `getChannelMessages` (avoids N+1), with a join-row split in the accessor. A single-message read helper (`getMessageWithAttachment`) gives the gateway parity.
- **`toPublicMessage(row, attachment)`** takes an explicit `AttachmentRow | null` second arg, so both the join path and the gateway (bare `MessageRow` + separately-fetched attachment) call it uniformly.
- **`PublicAttachment` exposes `id`, not a baked `url`** — the auth-checked download means the client resolves `GET /api/attachments/:id` itself; the data layer has no base-URL config.
- **Allowed-MIME list / `images` subpath config is deferred to story 002** (it owns validation + disk writes). Per AC the tunables are added "where they don't already exist"; adding them in 002 satisfies that without speculative config here. `MAX_UPLOAD_MB`/`DATA_DIR` already exist and are untouched.
- **Messages FK** is declared inline in the canonical `CREATE TABLE`; pre-existing M2 DBs keep the unenforced column (SQLite can't `ALTER … ADD CONSTRAINT`), so integrity lives in the accessor/gateway layer.

## Implementation Steps

### Step 1: Add the `attachments` table, its index, and the messages FK to the schema
**File(s):** `server/src/schema.ts`
**Action:** modify
**Description:** Extend `SCHEMA_SQL` with the `attachments` `CREATE TABLE IF NOT EXISTS` exactly per `SPEC.md §8`, add `CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id)`, and replace the M2 "no FK" comment on `messages.attachment_id` with a real `FOREIGN KEY (attachment_id) REFERENCES attachments(id)` plus a note that pre-existing M2 DBs retain the unenforced column. Update the top-of-file doc comment ("The `attachments` table is still deferred to M3") to reflect that it now exists. SQLite resolves FK targets lazily inside a single `db.exec`, so the forward reference (messages defined before attachments) is fine; both tables use `IF NOT EXISTS`.
**Diff shape:**
- Add: `CREATE TABLE IF NOT EXISTS attachments (...)` with columns `id INTEGER PRIMARY KEY AUTOINCREMENT`, `message_id INTEGER`, `uploader_id INTEGER NOT NULL`, `filename TEXT NOT NULL`, `content_type TEXT NOT NULL`, `size INTEGER NOT NULL`, `width INTEGER`, `height INTEGER`, `path TEXT NOT NULL`, `created_at INTEGER NOT NULL`, with `FOREIGN KEY (message_id) REFERENCES messages(id)` and `FOREIGN KEY (uploader_id) REFERENCES users(id)`.
- Add: `CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);`
- Change: `messages.attachment_id` line — drop the 3-line deferral comment, add `FOREIGN KEY (attachment_id) REFERENCES attachments(id)`; add a one-line note that pre-existing M2 DBs keep the column FK-less.
- Change: file header doc comment to note `attachments` now lands in M3 / this schema.

### Step 2: Add `AttachmentRow`, `PublicAttachment`, and the mapper; embed attachment in `PublicMessage`
**File(s):** `server/src/types.ts`
**Action:** modify
**Description:** Add `AttachmentRow` (snake_case, mirrors the table) and `PublicAttachment` (camelCase, exposes `id` — not a `url`). Add `toPublicAttachment(row): PublicAttachment`. Change `PublicMessage` to carry `attachment: PublicAttachment | null` in place of the inert `attachmentId`. Change `toPublicMessage` to the two-arg signature `(row: MessageRow, attachment: AttachmentRow | null)` mapping the attachment via `toPublicAttachment`. Update the `MessageSendPayload` comment to note `attachmentId` is now honored by M3 (story 003), not "ignored in M2".
**Diff shape:**
- Add: `interface AttachmentRow { id; message_id: number | null; uploader_id; filename; content_type; size; width: number | null; height: number | null; path; created_at }`.
- Add: `interface PublicAttachment { id; messageId: number | null; filename; contentType; size; width: number | null; height: number | null; createdAt }`.
- Add: `function toPublicAttachment(row: AttachmentRow): PublicAttachment`.
- Change: `PublicMessage` — replace `attachmentId: number | null` with `attachment: PublicAttachment | null`.
- Change: `toPublicMessage(row)` → `toPublicMessage(row: MessageRow, attachment: AttachmentRow | null)`, returning `attachment: attachment ? toPublicAttachment(attachment) : null`.
- Change: `MessageSendPayload` doc comment.

### Step 3: Create the `attachments.ts` accessor module
**File(s):** `server/src/attachments.ts`
**Action:** create
**Description:** New accessor module mirroring `channels.ts` exactly — `db`-first args, insert-then-re-`SELECT`-by-`lastInsertRowid`, return the full `AttachmentRow`. Exports `createAttachment`, `getAttachmentById`, `linkAttachmentToMessage` (link-once via `WHERE id = ? AND message_id IS NULL`, returning `info.changes === 1`).
**Diff shape:**
- Add: `createAttachment(db, { uploaderId, filename, contentType, size, width, height, path })` → `INSERT INTO attachments (...) VALUES (...)` with `message_id` NULL and `created_at = Date.now()`, re-SELECT, return `AttachmentRow`.
- Add: `getAttachmentById(db, id): AttachmentRow | undefined`.
- Add: `linkAttachmentToMessage(db, attachmentId, messageId): boolean` → `UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL`; `return info.changes === 1`.

### Step 4: Embed attachments in channel message reads
**File(s):** `server/src/channels.ts`
**Action:** modify
**Description:** Change `getChannelMessages` to `LEFT JOIN attachments a ON a.id = m.attachment_id`, selecting message columns plus aliased attachment columns into a join-row type, and split each row into `{ message: MessageRow, attachment: AttachmentRow | null }`. Add a single-message read `getMessageWithAttachment(db, id)` returning the same split shape (used by the gateway broadcast for parity). Define a small internal helper to map a raw join row to `{ message, attachment }` so both functions share it.
**Diff shape:**
- Change: `getChannelMessages` return type from `MessageRow[]` to `Array<{ message: MessageRow; attachment: AttachmentRow | null }>`; both query branches become `SELECT m.*, a.id AS a_id, a.message_id AS a_message_id, ...` over `messages m LEFT JOIN attachments a ON a.id = m.attachment_id`, preserving `WHERE channel_id`, `id < before`, `ORDER BY m.id DESC LIMIT`.
- Add: internal `splitMessageRow(raw)` mapping aliased columns → `{ message, attachment }` (attachment is `null` when `a_id` is null).
- Add: `getMessageWithAttachment(db, id): { message: MessageRow; attachment: AttachmentRow | null } | undefined`.
- Add: import `AttachmentRow` from `./types.js`.

### Step 5: Adapt the history route to the new mapper and row shape
**File(s):** `server/src/routes/channels.ts`
**Action:** modify
**Description:** `getChannelMessages` now returns `{ message, attachment }` pairs; map them with the two-arg `toPublicMessage(r.message, r.attachment)`.
**Diff shape:**
- Change: `rows.map(toPublicMessage)` → `rows.map((r) => toPublicMessage(r.message, r.attachment))`.

### Step 6: Update the gateway broadcast for the new `toPublicMessage` signature
**File(s):** `server/src/ws/gateway.ts`
**Action:** modify
**Description:** The `message.send` handler inserts a message then broadcasts `toPublicMessage(row)`. Update the call to the two-arg form passing `null` (no linking until story 003), keeping the broadcast shape correct so 003 only flips the value. `attachmentId` continues to be accepted-but-ignored on the wire in this story.
**Diff shape:**
- Change: `d: { message: toPublicMessage(row) }` → `d: { message: toPublicMessage(row, null) }`.
- Change: the `// 'attachmentId' is accepted ... ignored in M2` comment to note linking arrives in story 003.

### Step 7: Write the `attachments-data` contract
**File(s):** `context/features/m3-images/story-001-attachments-data/contracts/attachments-data.md`
**Action:** create
**Description:** Document (for stories 002–005) the `attachments` table shape, the messages FK note, the `attachments.ts` accessor API with link-once semantics, the `PublicAttachment` JSON and the `id`-resolves-to-`GET /api/attachments/:id` rule, the `PublicMessage.attachment` embedding, and the `toPublicMessage(row, attachment)` signature. Mirror the structure of M2's `channels-data.md`.
**Diff shape:**
- Add: contract markdown with `#contract` header, Tables, accessor API (ts block), public JSON shapes, link-once semantics, and usage notes for 002/003/005.

### Step 8: Typecheck
**File(s):** — (verification)
**Action:** —
**Description:** Run `npm run typecheck` (server `tsc --noEmit` + client `svelte-check`) — the only static gate. Confirm the two-arg `toPublicMessage`, the new join-row shapes, and the accessor module compile.

## New Types / Schemas / Contracts

```ts
// server/src/types.ts

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

interface PublicAttachment {
  id: number;            // client resolves bytes via GET /api/attachments/:id
  messageId: number | null;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  createdAt: number;
}

function toPublicAttachment(row: AttachmentRow): PublicAttachment;

// PublicMessage gains the embed (replaces `attachmentId`)
interface PublicMessage {
  id: number;
  channelId: number;
  authorId: number;
  content: string;
  attachment: PublicAttachment | null;
  createdAt: number;
}

function toPublicMessage(row: MessageRow, attachment: AttachmentRow | null): PublicMessage;
```

```ts
// server/src/attachments.ts
function createAttachment(
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
): AttachmentRow; // message_id NULL, created_at = Date.now()

function getAttachmentById(db: Db, id: number): AttachmentRow | undefined;

function linkAttachmentToMessage(db: Db, attachmentId: number, messageId: number): boolean;
// UPDATE ... WHERE id = ? AND message_id IS NULL; returns info.changes === 1
```

```ts
// server/src/channels.ts (read-side embedding)
type MessageWithAttachment = { message: MessageRow; attachment: AttachmentRow | null };
function getChannelMessages(db: Db, channelId: number, opts: { before?: number; limit: number }): MessageWithAttachment[];
function getMessageWithAttachment(db: Db, id: number): MessageWithAttachment | undefined;
```

SQLite `attachments` table (per `SPEC.md §8`):
```sql
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER,
  uploader_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id),
  FOREIGN KEY (uploader_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
```

## Configuration / Environment Changes
None this story. `MAX_UPLOAD_MB` and `DATA_DIR` already exist and are reused as-is; the allowed-MIME list and `DATA_DIR/images` subpath are deferred to story 002 (which owns upload validation and disk writes). New persisted columns: the entire `attachments` table (Step 1) and the now-enforced `messages.attachment_id` FK on fresh DBs.

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| persisted schema | `attachments` table | — | — | new table per SPEC §8; index on `message_id` |
| persisted schema | `messages.attachment_id` FK | — | — | FK → `attachments(id)`; enforced on fresh DBs only |
| public function | `toPublicMessage` | `(MessageRow, AttachmentRow \| null)` | `PublicMessage` | **signature change** — second arg added; all callers updated (Steps 5, 6) |
| public function | `createAttachment` | `(Db, { uploaderId, filename, contentType, size, width, height, path })` | `AttachmentRow` | `message_id` NULL, `created_at` set |
| public function | `getAttachmentById` | `(Db, id)` | `AttachmentRow \| undefined` | |
| public function | `linkAttachmentToMessage` | `(Db, attachmentId, messageId)` | `boolean` | link-once; `false` if already linked |
| public function | `getChannelMessages` | `(Db, channelId, { before?, limit })` | `MessageWithAttachment[]` | **return-shape change** — now `{ message, attachment }` pairs |
| public function | `getMessageWithAttachment` | `(Db, id)` | `MessageWithAttachment \| undefined` | new; gateway parity |
| JSON wire shape | `PublicMessage.attachment` | — | `PublicAttachment \| null` | replaces `attachmentId`; affects `message.create` + history responses |

## Edge Cases & Gotchas
- **Pre-existing M2 DB** — `CREATE TABLE IF NOT EXISTS messages` is a no-op, so the new FK is NOT retro-applied; integrity stays in the accessor/gateway layer (link-once + story-003 ownership checks). Handled in Step 1 (schema note) and documented in Step 7.
- **Forward/circular FK reference** — `messages` references `attachments` though defined earlier in the same `db.exec`; SQLite resolves FK targets lazily, so order is fine. Handled in Step 1.
- **Idempotent re-run** — all DDL uses `IF NOT EXISTS`; starting against an existing DB creates `attachments` once and is a no-op thereafter. Handled in Step 1, verified in Step 8.
- **Existing messages serialize with `attachment: null`** — `attachment_id` is NULL for all M2 rows, so the LEFT JOIN yields a null attachment and `toPublicMessage(row, null)` emits `attachment: null`. Handled in Steps 2, 4, 5.
- **Link-once concurrency** — `linkAttachmentToMessage` uses `WHERE message_id IS NULL` so a second link attempt changes 0 rows and returns `false`; never double-attaches. Handled in Step 3.
- **No baked `url`** — `PublicAttachment` deliberately omits `url`; the auth-checked download means the client builds `GET /api/attachments/:id` from `id`. Handled in Step 2, documented in Step 7.
- **N+1 avoidance** — history uses a single LEFT JOIN, not per-row lookups. Handled in Step 4.
- **Gateway parity placeholder** — broadcast passes `attachment: null` this story; story 003 swaps in the just-linked row via `getMessageWithAttachment` / the linked attachment. Handled in Step 6.

## Acceptance Criteria Checklist
- [ ] `attachments` table created idempotently exactly per SPEC §8, M1/M2 tables undisturbed → Step 1
- [ ] `messages` declares the `attachment_id` → `attachments(id)` FK; deferral comment updated; pre-existing-M2 note added → Step 1
- [ ] Index on `attachments(message_id)` → Step 1
- [ ] `attachments.ts` exports `createAttachment`, `getAttachmentById`, `linkAttachmentToMessage` (link-once) → Step 3
- [ ] `channels.ts` reads embed attachments (`getChannelMessages` + single-message read LEFT JOIN) → Step 4
- [ ] `types.ts` gains `AttachmentRow`, `PublicAttachment`; `PublicMessage.attachment`; updated mapper → Step 2
- [ ] New tunables sourced from `loadConfig()` where they don't already exist; `MAX_UPLOAD_MB`/`DATA_DIR` reused → handled by deferral decision (no new config this story); confirmed in Summary
- [ ] `npm run typecheck` passes; table created against existing M2 db, idempotent, existing messages serialize with `attachment: null` → Steps 1, 2, 4, 5, 6, 8
- [ ] `contracts/attachments-data.md` documents table, accessor API, link-once, `PublicAttachment`, embedding → Step 7
