---
story: 003
title: "Gateway: link attachmentId on message.send & embed in broadcasts"
status: TODO
depends_on: [001]
provides_contract: contracts/message-attachment-flow.md
---

#story

# Story 003: Gateway — link attachmentId on message.send & embed attachment in broadcasts

## User Story
As a member, I want a `message.send` that carries an `attachmentId` to actually attach my uploaded image, so that the resulting `message.create` (and the persisted history) shows the image to everyone.

## Acceptance Criteria
- [ ] The M2 gateway `message.send` handler (`server/src/ws/gateway.ts`) is extended to honor `attachmentId` instead of ignoring it: when present, it loads the attachment via `getAttachmentById` (story 001) and **validates** the row exists, `uploader_id === sender.id`, and it is **not already linked** (`message_id IS NULL`); on any failure the send is rejected (defined error op or ignored) and **no message row is persisted**.
- [ ] On success it persists the message with `attachment_id` set, calls `linkAttachmentToMessage` (story 001) to set `attachments.message_id` to the new message id (atomically with the insert, e.g. one transaction), and broadcasts a `message.create` whose `PublicMessage` **embeds the `attachment` object** (per story 001's mapper) to all connected sockets via the M2 hub.
- [ ] **Content rule:** `content` may be empty/whitespace **iff** a valid `attachmentId` is attached (image-only message); a `message.send` with neither non-empty content nor a valid attachment is rejected (relaxing the M2 "content required" rule only when an attachment is present). Max-length and envelope/size limits from M2 still apply to `content`.
- [ ] A `message.send` with no `attachmentId` behaves exactly as in M2 (plain text, `attachment: null`) — no regression.
- [ ] The history endpoint `GET /api/channels/:id/messages` returns the embedded `attachment` for image messages (via story 001's read-side embedding), so live `message.create` and reloaded history are structurally identical and dedupe by `id`.
- [ ] `npm run typecheck` passes; verifiable end-to-end with `wscat`/`websocat`: upload an image (story 002), send `message.send { channelId, content:"", attachmentId }`, observe a `message.create` carrying the `attachment` on a second connected socket, then fetch history and see the same embedded attachment; sending another client's `attachmentId`, a reused one, or a bogus id is rejected without persisting.
- [ ] `contracts/message-attachment-flow.md` documents the `message.send` attachment rules (ownership, link-once, content-optional-with-attachment) and the embedded-attachment shape on `message.create`/history for client stories 004 and 005.

## Context
`SPEC.md §10`: "Then `message.send` references it." `§7`/`§9`: messages are sent over WS and broadcast as `message.create`; history is fetched over REST. M2's gateway already accepts `attachmentId?` on the wire but stores `NULL` (`server/src/ws/gateway.ts`, `server/src/types.ts` `MessageSendPayload`) — this story makes it real. Builds on story 001's `getAttachmentById`/`linkAttachmentToMessage` and `PublicMessage.attachment` embedding, and M2's `contracts/channels-rest-api.md` history endpoint.

## Out of Scope
- The upload/download HTTP endpoints (story 002) — this story consumes the rows they create at runtime.
- Client compose/render UI (stories 004–005).
- Orphan GC for attachments never linked to a message (feature non-goal).
