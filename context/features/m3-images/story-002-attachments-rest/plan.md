#plan

# Plan: REST API — image upload & auth-checked download

## Summary
Add `@fastify/multipart` + `image-size` to the server, register an `attachmentRoutes` plugin inside `buildApp(config)`, and create the `DATA_DIR/images` directory on boot. The plugin exposes `POST /api/attachments` (Bearer-auth, byte-sniffed MIME validation, size cap, dimension probe, writes `DATA_DIR/images/<id>`, records the row via story-001's `createAttachment`) and `GET /api/attachments/:id` (Bearer-auth, streams stored bytes with the stored `Content-Type`/`Content-Length`).

## Decisions (resolved from research, all "Open Questions" were "None")
- **Dimension/MIME library:** `image-size` (pure JS, no native build) — it sniffs the format from header bytes and returns `{ width, height, type }`, doubling as the MIME validator. `sharp` rejected (heavy native + re-encode is a non-goal).
- **id↔path sequencing:** insert with a deterministic relative path computed *before* insert is impossible because the id is the autoincrement output. Use **insert-then-update**: `createAttachment` with a placeholder `path`, read `row.id`, write bytes to `DATA_DIR/images/<id>`, then a raw `UPDATE attachments SET path = ? WHERE id = ?` setting the **relative** path `images/<id>`. Story-001's contract is frozen (no path-setter accessor), so a raw statement in the route is acceptable and consistent with how `auth.ts` runs ad-hoc SQL. Wrap the whole sequence so a write failure deletes the row (no orphan).
- **Stored path is relative** (`images/<id>`), resolved on download with `join(config.dataDir, row.path)` so the DB is portable across `DATA_DIR` changes (matches `getAttachmentById`'s `path` semantics).
- **Buffer the upload in memory** — hard `fileSize` cap (`maxUploadMb`, default 10 MB) + ≤10 users makes a Buffer safe; `image-size` needs the bytes anyway. The framework's `limits.fileSize` prevents unbounded buffering.
- **Response body = full `PublicAttachment`** via `toPublicAttachment(row)` (a superset that includes `id`). The frozen story-003 contract only needs `attachmentId`, but the AC explicitly allows the full shape and client stories 004/005 benefit from the dimensions immediately. The contract documents `id` as the field clients read (equivalent to `attachmentId`).
- **Error strings (400-tier, AC leaves these to the plan):** `not_multipart`, `no_file`, `file_too_large` (413), `unsupported_media_type`, `invalid_image`. AC-mandated strings `attachment_not_found` (404) and `unauthorized` (401) are unchanged.
- **`@fastify/multipart` registered with `attachFieldsToBody: false`** (default) — handlers pull the part via `request.file()`. `limits.fileSize = config.maxUploadMb * 1024 * 1024`.
- **Allowed-MIME list + images subpath are module constants**, exported from `config.ts` (`ALLOWED_IMAGE_TYPES`, `imagesDir(config)`), per the story-001 contract ("no new env this story").

## Implementation Steps

### Step 1: Add dependencies
**File(s):** `server/package.json`
**Action:** modify
**Description:** Add the multipart parser and the pure-JS image probe so the route can accept files and validate/probe them with no native build (CI builds Docker + `tauri build` on ubuntu/windows).
**Diff shape:**
- Add to `dependencies`: `"@fastify/multipart": "^9.0.1"` and `"image-size": "^1.2.0"` (pin to the installed resolved versions after `npm install`).
- Run `npm install` in `server/` so `package-lock.json` updates.

### Step 2: Allowed-MIME constants + images dir helper
**File(s):** `server/src/config.ts`
**Action:** modify
**Description:** Export the allowed-image MIME set and a helper that resolves the images directory from config, so the route and boot code share one source of truth and path resolution goes through config (no env, per the contract).
**Diff shape:**
- Add `import { join } from "node:path";`
- Add `export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;`
- Add `export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];`
- Add `export function imagesDir(config: Config): string { return join(config.dataDir, "images"); }`

### Step 3: Image sniff/probe helper
**File(s):** `server/src/images.ts`
**Action:** create
**Description:** Thin wrapper over `image-size` that byte-sniffs a Buffer and returns the canonical MIME + dimensions, or `null` if the bytes are undecodable or not in the allowed set. Keeps the route handler thin and the "don't trust client Content-Type" rule in one place.
**Diff shape:**
- Add `import imageSize from "image-size";` (call as `imageSize(buffer)`), `import { ALLOWED_IMAGE_TYPES, type AllowedImageType } from "./config.js";`
- Map `image-size` `type` values to canonical MIME: `png→image/png`, `jpg→image/jpeg`, `gif→image/gif`, `webp→image/webp` (note `image-size` reports JPEG as `jpg`).
- Export `export function sniffImage(buffer: Buffer): { contentType: AllowedImageType; width: number; height: number } | null`:
  - `try { const r = imageSize(buffer); }` — on throw (undecodable) return `null`.
  - If `r.type` not in the map, or mapped MIME not in `ALLOWED_IMAGE_TYPES`, return `null`.
  - If `r.width`/`r.height` are not finite positive integers, return `null`.
  - Else return `{ contentType, width: r.width, height: r.height }`.

### Step 4: Attachment routes plugin
**File(s):** `server/src/routes/attachments.ts`
**Action:** create
**Description:** New `FastifyPluginAsync<AttachmentRoutesOptions>` mirroring `channels.ts`: `const { config } = opts; const db = app.db;`. Two routes, both `preHandler: requireAuth`.
**Diff shape:**
- Imports: `FastifyInstance`, `FastifyPluginAsync` from fastify; `Config`, `imagesDir` from `../config.js`; `requireAuth` from `../auth.js`; `createAttachment`, `getAttachmentById` from `../attachments.js`; `toPublicAttachment` from `../types.js`; `sniffImage` from `../images.js`; `createReadStream`, `promises as fs` from `node:fs`; `join` from `node:path`.
- `interface AttachmentRoutesOptions { config: Config }`.
- `const downloadParamsSchema = { params: { type: "object", required: ["id"], properties: { id: { type: "integer", minimum: 1 } }, additionalProperties: false } } as const;` (reuse the `messageHistorySchema.params` pattern).

- **`POST /api/attachments`** (no JSON body schema — multipart is a stream):
  1. `let part; try { part = await request.file(); } catch (err) { ... }` — `@fastify/multipart` throws on non-multipart content-type and on size overflow. Distinguish: if it is the size-limit error (`err.code === "FST_REQ_FILE_TOO_LARGE"` / `err instanceof app.multipartErrors? RequestFileTooLargeError`) → `413 { error: "file_too_large" }`; otherwise → `400 { error: "not_multipart" }`.
  2. If `part === undefined` (multipart but no file field) → `400 { error: "no_file" }`.
  3. Buffer the stream: `const buffer = await part.toBuffer();`. After buffering, check `part.file.truncated === true` (multipart sets this when the per-file `fileSize` cap is hit and the stream is consumed) → `413 { error: "file_too_large" }`. Also reject empty: `buffer.length === 0` → `400 { error: "no_file" }`.
  4. `const probe = sniffImage(buffer);` — `null` → `400 { error: "invalid_image" }` (covers both undecodable and disallowed/spoofed MIME). Plan note: AC bundles "disallowed MIME" and "undecodable image" both into 400; `sniffImage` returns `null` for both, so a single `invalid_image` is acceptable. If we want to distinguish unsupported-vs-corrupt, the helper could return a discriminated result — not required by AC, so keep one code (`invalid_image`) for simplicity, or split into `unsupported_media_type`/`invalid_image` if the helper distinguishes (optional; AC only needs a 400).
  5. **Insert → write → relative-path update**, with cleanup on failure:
     ```
     const filename = part.filename ?? "upload";
     const row = createAttachment(db, {
       uploaderId: request.user!.id,
       filename,
       contentType: probe.contentType,
       size: buffer.length,
       width: probe.width,
       height: probe.height,
       path: "",            // placeholder; updated to images/<id> below
     });
     const relPath = join("images", String(row.id));
     const absPath = join(imagesDir(config), String(row.id));
     try {
       await fs.writeFile(absPath, buffer);
       db.prepare("UPDATE attachments SET path = ? WHERE id = ?").run(relPath, row.id);
     } catch (err) {
       db.prepare("DELETE FROM attachments WHERE id = ?").run(row.id);
       await fs.rm(absPath, { force: true });   // remove partial write if any
       throw err;
     }
     ```
  6. Respond `201`: re-read the row (or mutate `row.path = relPath`) and `return reply.code(201).send(toPublicAttachment({ ...row, path: relPath }))`. `PublicAttachment` does not expose `path`, so the in-memory patch is enough.

- **`GET /api/attachments/:id`** (`{ schema: downloadParamsSchema, preHandler: requireAuth }`):
  1. `const row = getAttachmentById(db, request.params.id);` — `undefined` → `404 { error: "attachment_not_found" }`.
  2. `const absPath = join(config.dataDir, row.path);`
  3. `try { const stat = await fs.stat(absPath); } catch { return reply.code(404).send({ error: "attachment_not_found" }); }` — row present but file missing → clean 404, never a crash.
  4. `reply.header("Content-Type", row.content_type); reply.header("Content-Length", row.size); return reply.send(createReadStream(absPath));` — Fastify streams it. Wrap stream creation so a late read error is handled by Fastify's stream error path (logged, connection closed) rather than crashing the process.
- `export default attachmentRoutes;`

### Step 5: Register multipart + routes + create images dir on boot
**File(s):** `server/src/app.ts`
**Action:** modify
**Description:** Register `@fastify/multipart` with the size limit derived from config, register the new plugin alongside `channelRoutes`, and `mkdirSync` the images directory on boot (mirroring `db.ts`) so the route never races directory creation.
**Diff shape:**
- Add imports: `import multipart from "@fastify/multipart";`, `import { mkdirSync } from "node:fs";`, `import attachmentRoutes from "./routes/attachments.js";`, and `imagesDir` from `./config.js`.
- After `openDatabase`/`seedVoiceChannel`, add: `mkdirSync(imagesDir(config), { recursive: true });`
- Register multipart (before the attachment routes): `void app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });`
- Register the plugin: `void app.register(attachmentRoutes, { config });` (next to `channelRoutes`).

### Step 6: Write the contract
**File(s):** `context/features/m3-images/story-002-attachments-rest/contracts/attachments-rest-api.md`
**Action:** create
**Description:** Document both endpoints (method, path, auth, multipart field, success/error shapes, size/type limits, download `Content-Type`/`Content-Length` behavior) for client stories 004/005, using the channels-rest-api contract as the format template.
**Diff shape:**
- `#contract` header, intro referencing SPEC §10 + the story-001 data contract.
- `PublicAttachment` response shape (jsonc + TS) — re-stated from story-001 with the note that the upload returns it (and `id` is the value clients pass to `GET /api/attachments/:id`).
- Endpoint reference table (POST upload, GET download).
- Upload: multipart field name `file`, allowed types `image/png|jpeg|gif|webp` (byte-sniffed, client Content-Type/filename untrusted), size cap `MAX_UPLOAD_MB` (default 10), behavior steps, error table (`401 unauthorized`, `400 not_multipart/no_file/invalid_image`, `413 file_too_large`).
- Download: Bearer auth, streams stored bytes, `Content-Type` = stored, `Content-Length` set, no range support; errors `401 unauthorized`, `404 attachment_not_found` (unknown id or file missing on disk), `400 Bad Request` (non-integer id).

## New Types / Schemas / Contracts
- `ALLOWED_IMAGE_TYPES: readonly ["image/png","image/jpeg","image/gif","image/webp"]` and `AllowedImageType` (in `config.ts`).
- `imagesDir(config): string` → `join(config.dataDir, "images")`.
- `sniffImage(buffer): { contentType: AllowedImageType; width: number; height: number } | null` (in `images.ts`).
- HTTP surface (authoritative for stories 004/005):
  - `POST /api/attachments` → multipart field `file` → `201 PublicAttachment`.
  - `GET /api/attachments/:id` → streamed image bytes, stored `Content-Type`, `Content-Length`.
- Response body uses story-001's frozen `PublicAttachment` (no new wire type).
- Stored `attachments.path` is **relative** (`images/<id>`); download resolves `join(config.dataDir, row.path)`.

## Configuration / Environment Changes
None. No new env vars. `MAX_UPLOAD_MB` (`config.maxUploadMb`, default 10) and `DATA_DIR` (`config.dataDir`) are reused. The allowed-MIME list and `images` subpath are module constants in `config.ts`, not env (per the story-001 contract). `server/.env.example` is unchanged.

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| REST | `POST /api/attachments` | Bearer; multipart field `file` (single image) | `201 PublicAttachment` | Byte-sniffs MIME (png/jpeg/gif/webp), enforces `MAX_UPLOAD_MB`, probes w/h, writes `DATA_DIR/images/<id>`, records row with `message_id` NULL, `uploader_id = request.user.id` |
| REST | `GET /api/attachments/:id` | Bearer; path `id` (int ≥ 1) | `200` streamed bytes, `Content-Type` = stored, `Content-Length` = stored size | No range requests |
| REST error | `POST /api/attachments` | — | `400 {not_multipart}` / `400 {no_file}` / `400 {invalid_image}` / `413 {file_too_large}` / `401 {unauthorized}` | Nothing written to disk/DB on any rejection |
| REST error | `GET /api/attachments/:id` | — | `404 {attachment_not_found}` / `400 {Bad Request}` / `401 {unauthorized}` | 404 covers unknown id AND file-missing-on-disk |
| Module | `sniffImage(buffer)` | `Buffer` | `{ contentType, width, height } \| null` | `images.ts` |
| Module | `imagesDir(config)`, `ALLOWED_IMAGE_TYPES` | — | `string` / readonly tuple | `config.ts` |

## Edge Cases & Gotchas
- **Non-multipart request** → `request.file()` throws → `400 not_multipart` — handled in Step 4.1.
- **Multipart but no file field** / **empty file** → `400 no_file` — Step 4.2/4.3.
- **Over-cap size** → multipart `limits.fileSize` truncates; detected via the thrown `FST_REQ_FILE_TOO_LARGE` or `part.file.truncated` → `413 file_too_large` (nothing persisted) — Step 4.1/4.3.
- **Spoofed Content-Type / disallowed MIME (e.g. PDF, SVG)** → `sniffImage` returns `null` (bytes don't match an allowed image header) → `400 invalid_image`; stored `content_type` is always the sniffed value, never the client header — Step 4.4.
- **Corrupt/undecodable image** → `image-size` throws → `sniffImage` returns `null` → `400 invalid_image`; no row with bogus dimensions — Step 4.4.
- **id↔path dependency** → insert with placeholder path, write `images/<id>`, then `UPDATE … SET path` — Step 4.5.
- **Disk write fails after insert** → `DELETE` the row + `rm` any partial file so nothing survives (AC: clean up partial writes) — Step 4.5.
- **Directory race** → `images` dir created on boot in `buildApp`, not lazily per-request — Step 5.
- **Download row present but file gone (ENOENT)** → `fs.stat` catch → clean `404`, never a crash — Step 4 GET.3.
- **Download `Content-Type` is the stored type**, not re-sniffed per request; `Content-Length` set from `row.size` — Step 4 GET.4.
- **Unauthenticated GET/POST** → `requireAuth` returns `401 { error: "unauthorized" }` — preHandler on both routes.
- **`image-size` JPEG type quirk** → it reports `jpg`, mapped to `image/jpeg` — Step 3.
- **Relative-path portability** → store `images/<id>`, resolve with `join(config.dataDir, row.path)` so moving `DATA_DIR` doesn't break downloads — Steps 4.5 / 4 GET.2.

## Acceptance Criteria Checklist
- [ ] `@fastify/multipart` in `server/package.json`, registered in `buildApp` with `limits.fileSize = config.maxUploadMb * 1024 * 1024` → Steps 1, 5
- [ ] `POST /api/attachments` Bearer-auth, sniffs bytes for png/jpeg/gif/webp, enforces cap, probes w/h, writes `DATA_DIR/images/<id>` (dir created on boot), records row via `createAttachment` with `uploader_id` + `message_id` NULL, returns `201` → Steps 3, 4 (POST), 5
- [ ] `GET /api/attachments/:id` Bearer-auth streams stored file with stored `Content-Type` + `Content-Length`; unknown id → `404 attachment_not_found`; file missing → clean `404`, no crash → Step 4 (GET)
- [ ] Well-formed validation errors: `400` non-multipart/empty/disallowed MIME/undecodable, `413` over-cap, `401 unauthorized`; nothing persisted on rejection → Step 4 (POST), Edge Cases
- [ ] Routes register inside `buildApp` as `attachmentRoutes`, read `fastify.db` + config, no second connection, path resolution via config → Steps 2, 4, 5
- [ ] `npm run typecheck` passes; curl upload/download round-trip works; unauth GET `401`; `.pdf`/oversized rejected → all steps (verified post-implementation)
- [ ] `contracts/attachments-rest-api.md` documents both endpoints → Step 6
