---
story: 002
title: "WS gateway: message.send, broadcasts & ready.channels"
status: TODO
depends_on: [001]
provides_contract: contracts/ws-messaging.md
---

#story

# Story 002: WS gateway — message.send, broadcasts & ready.channels

## User Story
As a user, I want messages I send over the gateway to be persisted and pushed live to everyone, and the channel list to arrive on connect, so that conversation is realtime across all connected clients.

## Acceptance Criteria
- [ ] The M1 `ready` payload's `channels` field is populated from `listChannels` (story 001) as `PublicChannel[]`, replacing the M1 empty placeholder. `members` and the auth handshake are unchanged.
- [ ] The gateway handles inbound `message.send { channelId, content, attachmentId? }`: it validates the channel exists and `content` is non-empty (trimmed) and within the configured max length; persists via `insertMessage` (story 001) with `author_id` = the authenticated socket's user and `attachment_id = NULL`; then broadcasts `message.create { message: PublicMessage }`.
- [ ] `attachmentId` on `message.send` is **ignored** in M2 (stored `NULL`); `content` is still required.
- [ ] `message.create` and `channel.create` broadcast to **all** connected sockets via the in-memory hub (flat membership, ≤10 clients) — including an echo to the sender so its own message renders from the authoritative server row.
- [ ] A reusable broadcast helper is exposed (e.g. on the gateway hub / `app`) so the REST layer (story 003) can emit `channel.create { channel: PublicChannel }` after creating a channel.
- [ ] Invalid `message.send` (unknown `channelId`, empty/oversized `content`, malformed envelope) is ignored safely or answered with a defined error op — it never persists a bad row, never broadcasts, and never tears down the socket. Inbound frames stay size-limited (M1) and unknown ops are ignored.
- [ ] All frames use the `{ "op", "d" }` envelope (`SPEC.md §7`); only sockets that completed the M1 auth handshake may send.
- [ ] `npm run typecheck` passes; verifiable with two `wscat`/`websocat` clients holding valid sessions: both receive `ready` with the channel list, and when one sends `message.send` both receive `message.create`.
- [ ] `contracts/ws-messaging.md` documents the `message.send` / `message.create` / `channel.create` payloads, the `ready.channels` addition, and the broadcast-helper API — for story 003 (server) and stories 004–005 (client).

## Context
`SPEC.md §7` defines the envelope and the `message.send` (client→server) / `message.create` + `channel.create` (server→client) ops; `§9` says messages are sent over WS, persisted, then broadcast. This extends the M1 gateway (`story-004-ws-gateway-presence`) — reuse its `userId → Set<socket>` hub and `authenticateSession` handshake; do not stand up a second socket. With ≤10 clients an in-memory broadcast is sufficient.

## Out of Scope
- The `POST /api/channels` and `GET /api/channels/:id/messages` REST endpoints (story 003) — this story only emits `channel.create` via the helper that 003 calls.
- `voice.*` signaling/state (M4) and attachment handling (M3).
- Per-channel membership filtering — broadcasts go to everyone in v1.
