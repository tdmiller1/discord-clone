#research

# Research: REST API — image upload & auth-checked download

## Files to Touch

### Likely Modified
- `server/package.json` — add `@fastify/multipart` dependency; add an image-dimension probe dependency (`image-size`, pure-JS, zero native build — fits the ≤10-user, Docker+Windows CI constraint; mediasoup is the only native dep and we should avoid adding `sharp`).
- `server/src/app.ts` — register `@fastify/multipart` (with `limits.fileSize` from `config.maxUploadMb`), register the new `attachmentRoutes` plugin (mirroring the existing `channelRoutes` registration), and create the `DATA_DIR/images` directory on boot (next to where `db` is opened / `seedVoiceChannel` runs).
- `server/src/config.ts` — add an allowed-MIME constant/list and (optionally) a derived `imagesDir`. The contract says **no new env config**; `MAX_UPLOAD_MB`/`DATA_DIR` are reused. The allowed-image list and `images` subpath are owned by this story per the story-001 contract — expose them as constants (not env), e.g. `ALLOWED_IMAGE_TYPES` and a helper `imagesDir(config)` returning `join(config.dataDir, "images")`.
- `server/.env.example` — no change needed (no new env var); only touch if the plan decides to add one (it should not).

### Likely Created
- `server/src/routes/attachments.ts` — the `attachmentRoutes` `FastifyPluginAsync<{ config: Config }>` plugin exposing `POST /api/attachments` and `GET /api/attachments/:id`. Mirrors `server/src/routes/channels.ts` exactly (same options shape, `const db = app.db`, `requireAuth` preHandler).
- `server/src/images.ts` (optional helper) — byte-sniffing MIME detection + dimension probe wrapper around `image-size`, returning `{ contentType, width, height } | null`. Keeps the route thin and testable. Could also live inline in the route; plan decides.
- `contracts/attachments-rest-api.md` — the provided contract documenting both endpoints for client stories 004/005.

### Read-Only Reference (patterns to follow)
- `server/src/routes/channels.ts` — the canonical REST plugin shape: `FastifyPluginAsync<ChannelRoutesOptions>`, `const { config } = opts; const db = app.db;`, JSON-schema objects declared as `const … = { … } as const`, `requireAuth` in `preHandler`, typed route generics, `reply.code(201).send(...)`. Copy this structure.
- `server/src/routes/auth.ts` — error-body convention (`reply.code(4xx).send({ error: "snake_case_reason" })`), and the `transaction()` pattern if an insert+path-update needs atomicity.
- `server/src/auth.ts` — `requireAuth` sets `request.user` (`PublicUser`) and `request.session`; use `request.user!.id` as `uploader_id` (same as `request.user!.id` in channels create).
- `server/src/attachments.ts` — `createAttachment(db, {...})` returns the full `AttachmentRow`; `getAttachmentById(db, id)` returns `AttachmentRow | undefined`. These are the ONLY db calls this story makes.
- `server/src/types.ts` — `AttachmentRow`, `PublicAttachment`, `toPublicAttachment(row)` for the response body.
- `server/src/db.ts` — shows the `mkdirSync(dir, { recursive: true })` + `join()` idiom already used for `DATA_DIR`; reuse it for `DATA_DIR/images`.
- `context/features/m2-text-channels/story-003-channels-rest-api/contracts/channels-rest-api.md` — format template for the contract doc to write.

## Existing Patterns

- **Route plugin:** `const channelRoutes: FastifyPluginAsync<ChannelRoutesOptions> = async (app, opts) => { const { config } = opts; const db = app.db; … }` then `export default channelRoutes;`. Registered in `app.ts` via `void app.register(channelRoutes, { config });`. The new plugin must follow this verbatim.
- **Auth:** every protected route uses `{ … , preHandler: requireAuth }`. `requireAuth` already emits `401 { error: "unauthorized" }` (the exact body the AC requires) and attaches `request.user`/`request.session`. No new auth code needed.
- **Error bodies:** `reply.code(N).send({ error: "snake_case" })` — e.g. `channel_not_found`, `unauthorized`, `invalid_token`. New codes for this story: `attachment_not_found` (404, AC-specified), plus 400-tier reasons (`invalid_upload` / `unsupported_media_type` / `file_too_large` — plan picks the exact strings; AC only mandates `attachment_not_found` and `unauthorized`).
- **Config:** all tunables come from `loadConfig()` in `config.ts`; `config.maxUploadMb` and `config.dataDir` already exist. Per the contract, do NOT add env for the allowed-MIME list or the images subpath — bake them as module constants. Convert MB→bytes (`config.maxUploadMb * 1024 * 1024`) for the multipart `limits.fileSize`.
- **Disk dir creation:** `db.ts` does `mkdirSync(config.dataDir, { recursive: true })`. Create `DATA_DIR/images` the same way, on boot in `buildApp` (AC: "directory created on boot if absent"), so the route never races to create it.
- **JSON schema for params:** `messageHistorySchema.params` uses `{ id: { type: "integer", minimum: 1 } }` with `additionalProperties: false`; reuse for `GET /api/attachments/:id`. Note: multipart `POST` body is NOT validated by JSON schema (it's a stream) — validation is manual in the handler.
- **ESM:** `.js` import specifiers on all relative imports; `@fastify/multipart` and `image-size` are bare specifiers (no extension).

## Data Flow

**Upload — `POST /api/attachments`:**
1. `requireAuth` validates Bearer → `request.user`. Missing/invalid → `401 { error: "unauthorized" }`.
2. `@fastify/multipart` parses the request. Non-multipart content-type → framework error (map to 400). Use `request.file()` to get the single file part; absent → 400.
3. The framework enforces `limits.fileSize` (= `maxUploadMb`×1MB) while streaming — oversized truncates and flags `file.truncated` / throws, mapped to 413 (or 400). Buffer the part into memory (≤10 MB, acceptable for ≤10 users) or stream to a temp path.
4. **Sniff the bytes** (magic numbers) to determine the real MIME — do NOT trust `file.mimetype`/filename. Confirm it is one of `image/png|jpeg|gif|webp`; else 400. `image-size` both validates and yields `{ width, height, type }`; an undecodable image throws → 400. The sniffed `type` maps to the stored `content_type`.
5. Insert the row first to obtain the autoincrement id: the on-disk path is `DATA_DIR/images/<id>`, which depends on the id. Call `createAttachment(db, { uploaderId: request.user.id, filename: <client filename>, contentType: <sniffed>, size: <byte length>, width, height, path: <images/<id>> })`. **Ordering nuance (see Decisions):** the contract's `createAttachment` takes `path` as input but the path needs the id — resolve via two-step insert+write or a placeholder path.
6. Write bytes to `DATA_DIR/images/<id>` (`writeFileSync`/`fs.promises.writeFile`). On any failure here, the DB row must not survive (delete it) — AC: "nothing is written to disk or the DB; clean up partial writes."
7. Respond `201 { attachmentId: row.id }` (AC allows the full `PublicAttachment` via `toPublicAttachment(row)` — plan picks; contract for 003 only needs `attachmentId`, but 004/005 may want the full shape).

**Download — `GET /api/attachments/:id`:**
1. `requireAuth` → 401 if unauth.
2. `getAttachmentById(db, id)`; undefined → `404 { error: "attachment_not_found" }`.
3. Stream the file from `row.path` (resolve against `config.dataDir` if stored relative) with `reply.header("Content-Type", row.content_type)` and `Content-Length` (`row.size` or stat). Use `fs.createReadStream` and `reply.send(stream)`.
4. Row present but file missing on disk (`ENOENT`) → clean `404`/`500`, never a crash (catch the stream/stat error).

## Decisions Made

1. **Dimension probe = `image-size` (pure JS).** It sniffs the format from header bytes (so it doubles as the MIME validator) and returns `{ width, height, type }` for png/jpeg/gif/webp without a native build — important because CI builds the Docker image and runs `tauri build` on ubuntu+windows, and the repo avoids native deps beyond `better-sqlite3`/`mediasoup`. `sharp` is rejected (heavyweight native, and re-encode/thumbnail is an explicit non-goal). Final pick is the plan's, but `image-size` is the strong default; this research assumes it.
2. **MIME is decided by sniffing, not the client.** The stored `content_type` is whatever the byte-sniff/`image-size` reports (mapped to `image/png|jpeg|gif|webp`), satisfying the "don't trust Content-Type/filename" AC. `filename` is still taken from the client part (it's just a display label).
3. **Insert-then-write to resolve the id↔path dependency.** Because `path = DATA_DIR/images/<id>` needs the autoincrement id, and `createAttachment` (story-001 contract, frozen) only inserts with a caller-supplied `path` and has no path-update accessor: insert with a deterministic path string built from the *known-after-insert* id is impossible in one call. Plan options: (a) `createAttachment` with a placeholder/relative `path`, get `row.id`, write bytes to `images/<id>`, then `UPDATE attachments SET path = ? WHERE id = ?` directly in the route (raw db, since no accessor exists) — wrap insert+update+write so a write failure rolls back/deletes the row; or (b) store `path` as the relative `images/<id>` computed from `row.id` immediately after insert via that one UPDATE. Either way the route issues one extra `UPDATE`/`DELETE` against `app.db` directly (the story-001 contract is frozen and adds no path-setter/deleter, so a raw statement in the route is acceptable and consistent with how `auth.ts`/routes run ad-hoc SQL). Recommend storing the **relative** path (`images/<id>`) so the DB is portable across `DATA_DIR` changes, and resolving with `join(config.dataDir, row.path)` on download.
4. **Buffer the upload in memory.** With a hard `fileSize` cap of `maxUploadMb` (default 10 MB) and ≤10 users, reading the part into a Buffer is simple and safe; `image-size` needs the bytes (at least the header) anyway. The framework's `limits.fileSize` prevents unbounded buffering (AC requirement). Avoids temp-file cleanup complexity.
5. **`DATA_DIR/images` created on boot in `buildApp`** (not lazily in the route), mirroring `db.ts`'s `mkdirSync(..., { recursive: true })`, so concurrent uploads never race directory creation. Resolution goes through `config.dataDir` (a small `imagesDir(config)` helper), satisfying "path resolution goes through config."
6. **Allowed-MIME list + images subpath are module constants, not env** — per the story-001 contract ("no new config this story; the allowed-MIME list and `DATA_DIR/images` subpath are added by story 002"). Keep them in `config.ts` (or the route/images helper) as exported constants so 003/005 can reference the same set if needed.
7. **Response body = `201 { attachmentId }`** as the contract for story 003 requires, but additionally returning the full `PublicAttachment` (superset) is AC-allowed and useful for the client (004 can show the upload immediately). Plan decides; returning `{ attachmentId }` is the minimum that satisfies the frozen 003 contract.

## Open Questions

None — the story-001 contract, SPEC §10, and the existing channels/auth route patterns fully determine the design. The only genuinely open choice (dimension-probe library and the exact insert/path-update sequencing) is a plan-level implementation detail, not a blocker, and a strong default (`image-size`, insert-then-relative-path-update) is identified above.
