---
name: M3 — Images
description: Upload images in a message, have every client render them inline, and have attachments survive reload — over a REST multipart upload + auth-checked download, referenced from message.send.
type: feature
status: planned
completed_date:
---

# Feature: M3 — Images

## Problem Statement
M2 lets the ~10 users create text channels and exchange plain-text messages, but there is no way to share images. The protocol already carries an `attachmentId?` on `message.send` and the schema reserves a nullable `messages.attachment_id` column, but both are inert: `message.send` **ignores** the field and stores `NULL`, there is no `attachments` table, no `POST /api/attachments` / `GET /api/attachments/:id`, and the client has no compose-time upload or inline rendering. Users can describe a screenshot but cannot show it.

## Goal
Deliver the M3 acceptance loop from `SPEC.md §14` ("Upload an image in a message; other clients see it inline; survives reload") per `SPEC.md §10`. Concretely — a member picks an image in the composer; the client uploads it via multipart `POST /api/attachments`, which validates type/size, stores the file under `DATA_DIR/images/<id>`, records an `attachments` row, and returns `{ attachmentId }`; the client then sends `message.send { channelId, content, attachmentId }`; the server validates the attachment, links it to the new message, and broadcasts a `message.create` that **embeds the attachment metadata**; every connected client renders the image inline by streaming the bytes from the auth-checked `GET /api/attachments/:id`. On reload, the history fetch (`GET /api/channels/:id/messages`) returns the same embedded attachment, so the image reappears.

## Constraints
- **Server is ESM** (`"type": "module"`, NodeNext): relative TS imports must carry the `.js` extension. Reuse the M1/M2 foundations — `fastify.db` (`server/src/db.ts`), `requireAuth`/`authenticateSession` (`server/src/auth.ts`), the WS hub/broadcast (`server/src/ws/hub.ts`, `server/src/ws/gateway.ts`), the channels/messages accessors (`server/src/channels.ts`), and the existing `PublicMessage` shape (`server/src/types.ts`).
- New REST routes register **inside `buildApp(config)`** (`server/src/app.ts`, e.g. an `attachmentRoutes` plugin); the `attachmentId` wiring **extends the existing M2 gateway** `message.send` handler — it does not stand up a second socket. `index.ts` stays listen + signal-handling only.
- **Multipart uploads** require a new server dependency (`@fastify/multipart`) — not yet installed. Add it to `server/package.json`. Image **dimension probing** (width/height per `SPEC.md §8`) needs a lightweight image-size utility (e.g. `image-size`) or a minimal header parser; pick in story-plan.
- All new tunables flow through **`loadConfig()`** (`server/src/config.ts`) + `server/.env.example` — no scattered `process.env`. `MAX_UPLOAD_MB` (default **10**, `SPEC.md §10/§12`) and `DATA_DIR` already exist; reuse them. Files live under `DATA_DIR/images/<id>` on the mounted volume (`SPEC.md §4`); the directory is created on boot if absent.
- **Allowed types only:** `image/png|jpeg|gif|webp` (`SPEC.md §10`). Reject anything else and anything over `MAX_UPLOAD_MB` with a `4xx`; validate by sniffing the bytes, not by trusting the client-declared `Content-Type`/filename.
- **Schema extends idempotently** (`CREATE TABLE IF NOT EXISTS`) in `server/src/schema.ts` for `attachments` **exactly per `SPEC.md §8`** (`id, message_id NULL, uploader_id, filename, content_type, size, width, height, path, created_at`), without disturbing M1/M2 tables. The `messages.attachment_id` → `attachments(id)` FK that M2 deliberately deferred is declared in the canonical `messages` `CREATE TABLE` now that `attachments` exists (SQLite permits the forward/circular reference); on a **pre-existing M2 database** the `messages` table keeps its unenforced column (SQLite cannot `ALTER … ADD CONSTRAINT`), so integrity is enforced at the application layer regardless.
- **WS uses the `{ "op", "d" }` envelope** (`SPEC.md §7`); only authed sockets may send; the `message.send` path stays size-limited and rejects bad `attachmentId`s without crashing the socket.
- **Auth-checked download:** `GET /api/attachments/:id` requires a valid session (`SPEC.md §10`). A webview `<img src>` cannot attach an `Authorization: Bearer` header, so the client fetches the bytes with the session token and renders via an object URL (or an equivalent token-scoped scheme) — see Known Edge Cases.
- Frontend uses **Svelte 5 runes** (`$state`, …). **No test runner exists** — `npm run typecheck` is the only static gate; acceptance must be verifiable via typecheck + `curl`/`wscat`/`websocat` + running the client.

## Non-Goals
- **Thumbnails / image transforms / re-encoding** — explicitly deferred (`SPEC.md §10`: "Thumbnails optional/deferred"). Store and serve the original bytes; the client scales for display via CSS only.
- **Non-image attachments** (video, audio, arbitrary files) — only `image/png|jpeg|gif|webp` in v1.
- **Voice / SFU (M4):** `voice.*` ops and the voice channel type.
- **Edit / delete of messages or attachments, reactions, replies, threads, DMs, search** (`SPEC.md §2`).
- **Drag-and-drop / paste-to-upload / multi-image per message** beyond what's needed for the happy path — v1 supports one image attachment per message via a file picker (multi-image and paste/drag can be a later polish; keep the data model's one-attachment-per-message shape).
- **CDN / external object storage / signed expiring URLs** — files live on the local `/data` volume, served by the Node process.
- **Orphan/file GC and quota enforcement** beyond per-upload size limits — uploaded-but-never-sent attachments may linger; no background cleanup in v1 (noted as an edge case, not solved).

## Known Edge Cases
- Upload with a disallowed MIME (e.g. `application/pdf`, `image/svg+xml`), a spoofed `Content-Type` that doesn't match the bytes, a file over `MAX_UPLOAD_MB`, an empty body, or a non-multipart request → `4xx` with a defined error; nothing is written to disk or the DB.
- A valid-typed but corrupt/undecodable image (dimension probe fails) → reject `400`; do not persist a row with bogus dimensions.
- `message.send` with an `attachmentId` that doesn't exist, belongs to a **different uploader**, or is **already linked** to a message (`attachments.message_id IS NOT NULL`) → rejected/ignored; never links someone else's image or double-attaches one.
- **Image-only message:** `content` may be empty/whitespace **iff** a valid `attachmentId` is present; a message with neither content nor a valid attachment is rejected (the M2 "content required" rule is relaxed only when an attachment is attached).
- **Reload/reconnect persistence:** the history fetch and `ready` path must embed the attachment metadata so an image posted while a client was offline still renders on reconnect — parity with the live `message.create`.
- **Live/history dedupe:** an image message delivered live and also pulled via history (reconnect race) is deduped by message `id` and renders once, attachment included.
- **Auth on `GET /api/attachments/:id`:** missing/invalid session → `401`; the image bytes are never world-readable. The client must fetch with the Bearer token and convert to an object URL (revoking it on unmount to avoid leaks); a bare `<img src="/api/attachments/:id">` would 401.
- Download of a nonexistent/unknown attachment id → `404`; the file row exists but the file is missing on disk → `500`/`404` with a clean error, not a crash.
- `Content-Type` on download must reflect the **stored** type (not re-sniffed per request); `Content-Length` set; range requests are not required in v1.
- **Orphaned uploads:** an attachment uploaded but never referenced by a `message.send` stays `message_id NULL` and is not GC'd in v1 (acceptable; documented).
- Large but valid images (near the 10 MB cap) must not be buffered unboundedly in a way that risks the ≤10-user server — stream/limit per `@fastify/multipart` limits.

## User Stories

| # | Story Directory | Title | Status |
|---|----------------|-------|--------|
| 1 | story-001-attachments-data | Server data layer: attachments table, accessors & message embedding | TODO |
| 2 | story-002-attachments-rest | REST API: image upload & auth-checked download | TODO |
| 3 | story-003-message-attachment-gateway | Gateway: link attachmentId on message.send & embed in broadcasts | TODO |
| 4 | story-004-client-image-upload | Client: attach & upload an image in the composer | TODO |
| 5 | story-005-client-inline-images | Client: render attachments inline in the message pane | TODO |
