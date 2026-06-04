---
story: 001
title: "Server data layer: channels & messages"
status: TODO
depends_on: []
provides_contract: contracts/channels-data.md
---

#story

# Story 001: Server data layer — channels & messages

## User Story
As a developer, I want the SQLite `channels` and `messages` tables plus accessor helpers, so that the gateway and REST API build on one source of truth for channel/message persistence and history pagination.

## Acceptance Criteria
- [ ] `server/src/schema.ts` `applySchema` is extended to idempotently (`CREATE TABLE IF NOT EXISTS`) create `channels` and `messages` **exactly per `SPEC.md §8`** — column names, types, nullable/defaults — without disturbing the M1 tables.
- [ ] `channels`: `id INTEGER PK AUTOINCREMENT`, `name TEXT NOT NULL`, `type TEXT NOT NULL` (`CHECK (type IN ('text','voice'))`), `position INTEGER NOT NULL`, `created_by INTEGER` (FK → `users(id)`, nullable for future system-seeded channels), `created_at INTEGER NOT NULL` (epoch ms).
- [ ] `messages`: `id INTEGER PK AUTOINCREMENT`, `channel_id INTEGER NOT NULL` (FK → `channels(id)`), `author_id INTEGER NOT NULL` (FK → `users(id)`), `content TEXT NOT NULL`, `attachment_id INTEGER` **nullable with NO enforced FK** (the `attachments` table is M3; under `foreign_keys = ON` a FK to a missing table errors — document the deferral), `created_at INTEGER NOT NULL`.
- [ ] An index exists on `messages(channel_id, id)` to support keyset history pagination on `id`.
- [ ] An accessor module (e.g. `server/src/channels.ts`) exports, built on the `Db` handle: `createChannel`, `getChannelById`, `listChannels` (ordered by `position`, then `id`), `insertMessage`, and `getChannelMessages(db, channelId, { before?, limit })` — keyset on `id` (`id < before` when given), newest-first, `limit` clamped to a configured cap.
- [ ] Row + public JSON types are added to `server/src/types.ts`: `ChannelRow`/`MessageRow` (snake_case, mirror the tables) and `PublicChannel`/`PublicMessage` (camelCase API shapes — `channelId`, `authorId`, `attachmentId`, `createdAt`).
- [ ] Any new tunables (max message length, default/max history page size) are added to `loadConfig()` + `server/.env.example`, not read ad-hoc from `process.env`.
- [ ] `npm run typecheck` passes; starting the server against an existing M1 db creates the new tables without error (verifiable via `sqlite3` inspection); re-running is idempotent.
- [ ] `contracts/channels-data.md` documents the table shapes, the accessor API, the pagination semantics, and the `PublicChannel`/`PublicMessage` JSON so stories 002 and 003 can rely on them.

## Context
`SPEC.md §8` defines the `channels` and `messages` columns; `§9` defines plain-text content, monotonic-`id` ordering, and keyset history (`before` cursor, `limit` 50). This builds directly on M1's `contracts/data-and-crypto.md` — reuse `openDatabase`/`applySchema` conventions (epoch-ms timestamps, `0/1` booleans, `foreign_keys = ON`) and the `fastify.db` handle; do **not** open a second connection.

## Out of Scope
- The `attachments` table and any image handling (M3) — `messages.attachment_id` is just a nullable column here.
- REST routes, the WS gateway, and any broadcast logic (stories 002–003 consume this layer).
- Channel rename/delete/reorder helpers — only create/list/read are needed for M2.
