---
story: 002
title: "REST API: image upload & auth-checked download"
status: TODO
depends_on: [001]
provides_contract: contracts/attachments-rest-api.md
---

#story

# Story 002: REST API — image upload & auth-checked download

## User Story
As a member, I want to upload an image and later stream it back, so that the client can attach an image to a message and every client can render it inline.

## Acceptance Criteria
- [ ] `@fastify/multipart` is added to `server/package.json` and registered inside `buildApp(config)` with a file-size limit derived from `config.maxUploadMb` (so oversized uploads are rejected by the framework, not buffered unboundedly).
- [ ] `POST /api/attachments` (Bearer auth via M1 `requireAuth`) accepts a single multipart file field: it **sniffs the bytes** to confirm one of `image/png|jpeg|gif|webp` (not trusting the client `Content-Type`/filename), enforces the `MAX_UPLOAD_MB` cap, probes width/height, writes the bytes to `DATA_DIR/images/<id>` (directory created on boot if absent), records the row via `createAttachment` (story 001) with `uploader_id = request.user.id` and `message_id` NULL, and returns `201 { attachmentId }` (or the full `PublicAttachment`).
- [ ] `GET /api/attachments/:id` (Bearer auth) streams the stored file with the **stored** `Content-Type` and a `Content-Length`; unknown id → `404 { "error": "attachment_not_found" }`; row present but file missing on disk → a clean `404`/`500`, never a crash. Range requests are not required.
- [ ] Validation errors are well-formed: `400` for non-multipart / empty / disallowed MIME / undecodable image, `413` (or `400`) for over-cap size, `401 { "error": "unauthorized" }` for missing/invalid Bearer. On any rejection nothing is written to disk or the DB (clean up partial writes).
- [ ] Routes register inside `buildApp(config)` (e.g. an `attachmentRoutes` plugin) and read `fastify.db` + `config` — no second db connection, no global singletons; `DATA_DIR/images` path resolution goes through config.
- [ ] `npm run typecheck` passes; verifiable with `curl`: `curl -F file=@img.png -H "Authorization: Bearer <session>" .../api/attachments` returns an `attachmentId`, the file appears under `DATA_DIR/images/`, and `curl -H "Authorization: Bearer <session>" .../api/attachments/<id> -o out.png` returns the original bytes with the right `Content-Type`; an unauthenticated GET returns `401`; a `.pdf` or oversized upload is rejected.
- [ ] `contracts/attachments-rest-api.md` documents both endpoints (method, path, auth, multipart field name, success + error shapes, size/type limits, the download `Content-Type` behavior) for client stories 004 and 005.

## Context
`SPEC.md §10`: "Upload (REST, multipart): `POST /api/attachments` → server validates type/size, stores file under `/data/images/<id>`, records row, returns `{attachmentId}`. Then `message.send` references it." / "Download/stream: `GET /api/attachments/:id` (auth-checked), correct `Content-Type`." / "allow `image/png|jpeg|gif|webp`; max size (default 10 MB, configurable)." Builds on story 001's accessors/types and M1's `requireAuth`/`PublicUser` (`contracts/auth-api.md`) and config conventions.

## Out of Scope
- Referencing the attachment from a message (story 003 wires `message.send`).
- Thumbnail generation / transforms, multi-file uploads, drag-and-drop (feature non-goals).
- Client UI (stories 004–005).
