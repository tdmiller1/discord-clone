---
name: M2 — Text Channels
description: Create text channels and send/receive plain-text messages live over the WS gateway, with persisted history that survives reload.
type: feature
status: done
completed_date: 2026-06-04
---

# Feature: M2 — Text Channels

## Problem Statement
M1 lets the ~10 users authenticate and see who is online, but there is nowhere to actually talk: no channels, no messages. The `ready` payload still ships an **empty `channels` placeholder** (M1 non-goal), and the data model has no `channels`/`messages` tables, so users can sign in and watch presence but cannot communicate.

## Goal
Deliver the M2 acceptance loop from `SPEC.md §14`: any member can **create a text channel**, **send/receive plain-text messages live** across all connected clients, and on **reload/relaunch see the persisted channel list and message history**. Concretely — an admin or user creates `#general` via `POST /api/channels`; messages sent with `message.send` over the WS are persisted and broadcast as `message.create` to everyone; a returning client reconnects, gets the channel list in `ready`, fetches history via `GET /api/channels/:id/messages`, and sees the full prior conversation.

## Constraints
- **Server is ESM** (`"type": "module"`, NodeNext): relative TS imports must carry the `.js` extension. Reuse the M1 foundations — `fastify.db` (`server/src/db.ts`), `requireAuth`/`authenticateSession` (`server/src/auth.ts`), and the gateway's in-memory connection hub.
- New REST routes register **inside `buildApp(config)`** (`server/src/app.ts`); the gateway work **extends the existing M1 gateway module** (`message.send` handling + broadcast), it does not stand up a second socket. `index.ts` stays listen + signal-handling only.
- Schema is extended **idempotently** in `server/src/schema.ts` (`CREATE TABLE IF NOT EXISTS`) for `channels` and `messages` **exactly per `SPEC.md §8`** (column names, types, nullable/defaults). With `PRAGMA foreign_keys = ON`, `messages.attachment_id` is a **nullable column with no enforced FK** (the `attachments` table is M3 — a FK to a missing table errors on open); the FK is added in M3.
- All new settings flow through **`loadConfig()`** (`server/src/config.ts`) + `server/.env.example` — no scattered `process.env` reads (e.g. a configurable max message length and history page size with sane defaults).
- **Plain text only** in v1 (`SPEC.md §9`): no markdown, mentions, or formatting. Message ordering is by the server-assigned monotonic `id`; history uses **keyset pagination on `id`** (`before` cursor, `limit` default 50).
- **WS uses the `{ "op", "d" }` envelope** (`SPEC.md §7`); only sockets that completed the M1 auth handshake may send; inbound frames stay **size-limited** and unknown/invalid ops are ignored safely.
- **Flat membership / ≤10 clients:** there are no per-channel memberships in v1 — every authenticated user is in every text channel, so `message.create` / `channel.create` broadcast to **all** connected sockets via the in-memory hub (no broker).
- Frontend uses **Svelte 5 runes** (`$state`, …). **No test runner exists** — `npm run typecheck` is the only static gate; acceptance must be verifiable via typecheck + `curl`/`wscat`/`websocat` + running the client.

## Non-Goals
- **Images / attachments (M3):** the `attachments` table, `POST /api/attachments`, and inline image rendering. The `attachmentId?` field on `message.send` exists in the protocol but is **ignored** in M2 (stored as `NULL`).
- **Voice / SFU (M4):** `voice.*` ops and the voice channel type. The `channels.type` column supports `voice`, but M2 only **creates and renders `type:"text"`** channels (the create endpoint rejects `voice`).
- **Roles / permissions:** any member can create channels and post (one flat member role per `SPEC.md §2`).
- **Edit / delete / reactions / replies / threads / DMs / search** (`SPEC.md §2` non-goals).
- **Channel rename / delete / reorder:** the `position` column is assigned on create but there is no reordering or management UI.
- **Unread badges / read receipts / typing indicators** — not in the spec.

## Known Edge Cases
- Create channel with empty/whitespace name, name over the max length, or `type` ≠ `"text"` → `400`. Duplicate channel names are **allowed** (`channels.name` is not `UNIQUE` in `SPEC.md §8`).
- `message.send` with empty/whitespace content, content over the max length, an unknown/nonexistent `channelId`, or a malformed envelope → ignored or a defined error op; never persists a bad row and never crashes the socket.
- `message.send` carrying an `attachmentId` in M2 → the field is ignored and stored `NULL` (attachments are M3); `content` is still required.
- History fetch for a nonexistent channel → `404`; a `before` cursor past the oldest message → empty list; `limit` above the cap is clamped.
- **Reconnect/reload persistence:** a client that was offline when a channel or message was created still sees the channel in `ready.channels` on reconnect and the messages via the history fetch (the live `channel.create`/`message.create` it missed are recovered from persisted state).
- **Live/history dedupe:** a message delivered live via `message.create` that the client also pulled via the history fetch (reconnect race) must be **deduped by `id`** so it renders once.
- Switching the active channel loads that channel's history; messages arriving for a non-active channel are cached/updated without disrupting the current view.
- Author identity: `message.create` and history rows carry `authorId`; the client resolves the display name from the `members` map delivered in `ready` (M1) — a message from a user not yet in the map degrades gracefully.

## User Stories

| # | Story Directory | Title | Status |
|---|----------------|-------|--------|
| 1 | story-001-channels-messages-schema | Server data layer: channels & messages | COMPLETE |
| 2 | story-002-messaging-gateway | WS gateway: message.send, broadcasts & ready.channels | COMPLETE |
| 3 | story-003-channels-rest-api | REST API: create channel & message history | COMPLETE |
| 4 | story-004-client-channel-list | Client: channel list, selection & create-channel | COMPLETE |
| 5 | story-005-client-message-pane | Client: message history, composer & live updates | COMPLETE |
