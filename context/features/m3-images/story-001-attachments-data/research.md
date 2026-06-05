#research

# Research: Server data layer — attachments table, accessors & message embedding

## Files to Touch

### Likely Modified
- `server/src/schema.ts` — add the `attachments` `CREATE TABLE IF NOT EXISTS` (exactly per SPEC §8) and the `attachments(message_id)` index; declare the `messages.attachment_id` → `attachments(id)` FK in the canonical `messages` `CREATE TABLE`; update the M2 deferral comment to a note that pre-existing M2 dbs keep the unenforced column.
- `server/src/types.ts` — add `AttachmentRow` (snake_case) and `PublicAttachment` (camelCase); add `attachment: PublicAttachment | null` to `PublicMessage` (replacing the inert `attachmentId`); add `toPublicAttachment(row)`; update `toPublicMessage` to accept the joined attachment and embed it.
- `server/src/channels.ts` — change `getChannelMessages` (and add a single-message read for the gateway) to LEFT JOIN / follow-up-lookup `attachments` so each returned shape carries its attachment row; `toPublicMessage` consumers need the attachment row available.
- `server/src/ws/gateway.ts` — `message.send` broadcast at lines ~213-223 calls `toPublicMessage(row)`; must now supply the attachment (currently always `null`) so the new `toPublicMessage` signature compiles. (Linking itself is story 003; this story only makes the read/embed side compile and pass `null`.)
- `server/src/routes/channels.ts` — line ~97-98 `getChannelMessages(...).map(toPublicMessage)` must adapt to the new mapper signature / row shape carrying the attachment.
- `server/src/config.ts` — add an allowed-MIME-list tunable and the `DATA_DIR/images` subpath derivation **only if** they don't already exist (`MAX_UPLOAD_MB` and `DATA_DIR` already exist and must be reused). Note: the table/accessor layer of this story may not strictly need these; add the allowed-MIME config here if it cleanly belongs to the data layer, otherwise defer to story 002. See Decisions.
- `server/.env.example` — mirror any new config field.

### Likely Created
- `server/src/attachments.ts` — new accessor module on the `Db` handle: `createAttachment`, `getAttachmentById`, `linkAttachmentToMessage`. Mirrors `server/src/channels.ts` structure exactly.
- `context/features/m3-images/story-001-attachments-data/contracts/attachments-data.md` — the provided contract (frontmatter `provides_contract: contracts/attachments-data.md`).

### Read-Only Reference (patterns to follow)
- `server/src/channels.ts` — the canonical accessor-module shape: `db`-first args, insert-then-re-`SELECT`-by-`lastInsertRowid`, return full `*Row`. Copy directly for `attachments.ts`.
- `context/features/m2-text-channels/story-001-channels-messages-schema/contracts/channels-data.md` — the contract format/structure to copy for `attachments-data.md`.
- `server/src/db.ts` / `server/src/schema.ts` — `openDatabase` applies `applySchema` on every open with `foreign_keys = ON`, WAL; epoch-ms timestamps, 0/1 booleans.

## Existing Patterns

**Accessor module (`channels.ts`):** every function takes `db: Db` first. Writes do
`db.prepare("INSERT ... VALUES (?, ...)").run(...)` then re-`SELECT * FROM t WHERE id = ?`
with `Number(insert.lastInsertRowid)`, casting the result to the `*Row` type. Reads return
`*Row` / `*Row[]` / `*Row | undefined`. `Date.now()` supplies `created_at`. Copy this shape
for `attachments.ts`:
- `createAttachment(db, { uploaderId, filename, contentType, size, width, height, path })` → inserts with `message_id` NULL, `created_at = Date.now()`, returns `AttachmentRow`.
- `getAttachmentById(db, id)` → `AttachmentRow | undefined`.
- `linkAttachmentToMessage(db, attachmentId, messageId)` → `UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL`; return `info.changes === 1` (link-once semantics; ownership validated by the caller in story 003).

**Schema (`schema.ts`):** one `SCHEMA_SQL` template string of `CREATE TABLE IF NOT EXISTS` +
`CREATE INDEX IF NOT EXISTS`, run via `db.exec`. Add the `attachments` table and its index here.
The `messages` table currently has an explicit comment (lines 59-62) that `attachment_id` carries
**no FK** because `attachments` didn't exist; replace with a real `FOREIGN KEY (attachment_id) REFERENCES attachments(id)` and a note about pre-existing M2 dbs. SQLite tolerates the forward
reference inside a single `db.exec` and tolerates `messages` referencing `attachments` even though
`attachments` is defined later in the same script (FK targets are resolved lazily; also both use
`IF NOT EXISTS` so order of creation across runs is fine).

**Types (`types.ts`):** snake_case `*Row` interfaces mirror columns; camelCase `Public*` shapes;
`to Public*(row)` mappers. Nullable integer columns are typed `number | null`. `width`/`height`
are nullable. Follow `MessageRow`/`PublicMessage`/`toPublicMessage` exactly.

**Config (`config.ts`):** `Config` interface + `loadConfig()` reading env via the `num()` helper or
`process.env.X ?? default`. `maxUploadMb` (`MAX_UPLOAD_MB`, default 10) and `dataDir` (`DATA_DIR`)
already exist — reuse them, do not re-read env.

## Data Flow

This story is the **read/embed + persistence-primitive** layer; the write/link flow is wired in
stories 002 (upload) and 003 (gateway link). Relevant paths it must support:

1. **Upload primitive (story 002 consumes):** REST `POST /api/attachments` → validates → writes file
   to `DATA_DIR/images/<id>` → `createAttachment(db, {...})` returns the row → responds `{ attachmentId: row.id }`.
   This story provides `createAttachment` + the table.

2. **Link primitive (story 003 consumes):** gateway `message.send` with `attachmentId` →
   `getAttachmentById` (validate exists, uploader matches, `message_id IS NULL`) → `insertMessage` →
   `linkAttachmentToMessage(db, attachmentId, message.id)` (link-once). This story provides
   `getAttachmentById` + `linkAttachmentToMessage`.

3. **Read/embed (this story wires now):**
   - History: `GET /api/channels/:id/messages` (`routes/channels.ts:97-98`) →
     `getChannelMessages(db, id, {before, limit})` → each row mapped through `toPublicMessage`,
     which must now embed `attachment: PublicAttachment | null`. The accessor LEFT JOINs `attachments`
     (or does a per-row lookup) so the message carries its attachment row.
   - Live broadcast: gateway `message.send` (`ws/gateway.ts:213-223`) → after insert, builds
     `toPublicMessage(row)` for the `message.create` broadcast. Needs a single-message read that
     fetches the embedded attachment with the same parity as history. In this story the value is
     always `null` (no linking yet) but the **shape/signature** must be correct so 003 only flips a value.

## Decisions Made

1. **Embed via LEFT JOIN vs. follow-up lookup.** The AC permits either. Choose: `getChannelMessages`
   does a `LEFT JOIN attachments a ON a.id = m.attachment_id`, selecting message columns plus
   aliased attachment columns, and the mapper splits them. Rationale: avoids N+1 lookups on a history
   page; the `idx_attachments_message_id` index is for the inverse direction but the join here is on
   `attachments.id` (PK) so it's covered regardless. A row-shape carrying both halves keeps a single
   round-trip consistent with M2's "re-SELECT and map" ethos. If a clean join row type is awkward,
   a per-row `getAttachmentById` follow-up is an acceptable fallback (≤10 users, small pages).

2. **`toPublicMessage` signature change.** Make `toPublicMessage(row, attachment)` take an explicit
   `AttachmentRow | null` second arg (mapped internally via `toPublicAttachment`), rather than
   reading a joined field off an extended row. Rationale: keeps `toPublicMessage` callable from the
   gateway (which has a bare `MessageRow` + a separately-fetched attachment) and from the join path
   uniformly; least surprising for story 003 which will pass the just-linked attachment row.

3. **`PublicAttachment.url` vs `id`.** The AC offers "`url` or the `id` the client resolves to
   `GET /api/attachments/:id`". Choose: expose `id` (and the descriptive fields) and let the client
   construct `GET /api/attachments/:id`; do **not** synthesize a `url`. Rationale: the download is
   auth-checked and the client must fetch with a Bearer token into an object URL (feature spec /
   §10), so a server-baked `url` would be misleading and the data layer has no base-URL config.
   Document the resolution rule in the contract.

4. **Allowed-MIME config placement.** The pure data layer (table + accessors + embedding) does not
   itself validate MIME — that's the upload route (story 002). Decision: do **not** add the allowed-MIME
   list or `images` subpath to `config.ts` in this story unless trivially clean; defer to story 002,
   which owns validation and disk writes. The AC says add tunables "where they don't already exist" —
   adding them in 002 satisfies that without speculative config here. (Flag for plan phase to confirm.)

5. **Messages FK on a fresh DB.** Declared inline in the `messages` `CREATE TABLE`. On a fresh deploy
   both tables are created in one `db.exec`; on a pre-existing M2 db `messages` already exists so
   `CREATE TABLE IF NOT EXISTS` is a no-op and the column stays FK-less — integrity enforced in the
   accessor/gateway layer (`linkAttachmentToMessage` + 003's ownership checks). Documented per AC.

## Open Questions

None — all ambiguities resolved against existing M1/M2 patterns and the feature spec.
