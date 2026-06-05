---
story: 001
title: "Server data layer: attachments table, accessors & message embedding"
status: TODO
depends_on: []
provides_contract: contracts/attachments-data.md
---

#story

# Story 001: Server data layer — attachments table, accessors & message embedding

## User Story
As a developer, I want the SQLite `attachments` table, its accessor helpers, and the `PublicAttachment` JSON shape embedded into `PublicMessage`, so that the upload REST endpoint, the gateway, and the history endpoint build on one source of truth for image persistence and message rendering.

## Acceptance Criteria
- [ ] `server/src/schema.ts` `applySchema` is extended to idempotently (`CREATE TABLE IF NOT EXISTS`) create `attachments` **exactly per `SPEC.md §8`** — `id INTEGER PK AUTOINCREMENT`, `message_id INTEGER` (nullable, FK → `messages(id)`), `uploader_id INTEGER NOT NULL` (FK → `users(id)`), `filename TEXT NOT NULL`, `content_type TEXT NOT NULL`, `size INTEGER NOT NULL`, `width INTEGER`, `height INTEGER` (nullable), `path TEXT NOT NULL`, `created_at INTEGER NOT NULL` (epoch ms) — without disturbing the M1/M2 tables.
- [ ] The canonical `messages` `CREATE TABLE` now declares the previously-deferred `attachment_id` → `attachments(id)` foreign key (SQLite permits the forward/circular reference between `messages` and `attachments`). The deferral comment from M2 is updated; a clear note documents that a **pre-existing M2 database keeps the unenforced column** (SQLite cannot `ALTER … ADD CONSTRAINT`) and that integrity is therefore enforced in the accessor/gateway layer.
- [ ] An index exists on `attachments(message_id)` to support embedding attachments when listing a channel's messages.
- [ ] An accessor module (`server/src/attachments.ts`), built on the `Db` handle, exports: `createAttachment` (uploader_id, filename, content_type, size, width, height, path → row, `message_id` NULL), `getAttachmentById`, and `linkAttachmentToMessage(db, attachmentId, messageId)` which sets `attachments.message_id` **only if currently NULL** (and the caller validates ownership) — returning whether the link succeeded.
- [ ] `server/src/channels.ts` message reads embed attachments: `getChannelMessages` (and any single-message read used by the gateway broadcast) LEFT JOIN `attachments` (or a follow-up lookup) so each returned `PublicMessage` carries an `attachment: PublicAttachment | null`.
- [ ] `server/src/types.ts` gains `AttachmentRow` (snake_case, mirrors the table) and `PublicAttachment` (camelCase API shape — `id`, `messageId`, `filename`, `contentType`, `size`, `width`, `height`, `url` or the `id` the client resolves to `GET /api/attachments/:id`, `createdAt`); `PublicMessage` gains `attachment: PublicAttachment | null` (replacing/augmenting the inert `attachmentId` placeholder), with a `toPublicMessage`-style mapper updated accordingly.
- [ ] Any new tunables (allowed MIME list, `DATA_DIR/images` subpath) are sourced from `loadConfig()` + `server/.env.example` where they don't already exist; `MAX_UPLOAD_MB` and `DATA_DIR` are reused, not re-read ad hoc.
- [ ] `npm run typecheck` passes; starting the server against an existing M2 db creates the `attachments` table without error (verifiable via `sqlite3`), is idempotent on re-run, and existing messages still serialize with `attachment: null`.
- [ ] `contracts/attachments-data.md` documents the table shape, the accessor API, the link-once semantics, the `PublicAttachment` JSON, and the `PublicMessage.attachment` embedding so stories 002–005 can rely on them.

## Context
`SPEC.md §8` defines the `attachments` columns; `§10` defines allowed image types, the `DATA_DIR/images/<id>` storage path, and inline rendering. This builds on M2's `contracts/channels-data.md` — reuse `openDatabase`/`applySchema` conventions (epoch-ms timestamps, `0/1` booleans, `foreign_keys = ON`, the `fastify.db` handle) and the existing `PublicMessage` mapper. M2 left `messages.attachment_id` as a nullable, FK-less column expressly so this story could add the FK and the `attachments` table.

## Out of Scope
- The `POST`/`GET` attachment HTTP routes and multipart handling (story 002).
- The gateway `message.send` linking/validation flow (story 003) — this story only provides `linkAttachmentToMessage` plus the read-side embedding.
- Thumbnail generation, image re-encoding, orphan GC (feature non-goals).
