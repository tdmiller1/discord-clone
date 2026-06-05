---
story: 004
title: "Client: attach & upload an image in the composer"
status: TODO
depends_on: [002, 003]
provides_contract:
---

#story

# Story 004: Client — attach & upload an image in the composer

## User Story
As a member, I want to pick an image in the message composer and send it, so that my image appears in the channel for everyone.

## Acceptance Criteria
- [ ] The message composer (`client/src/lib/MessagePane.svelte`, using Svelte 5 runes) gains an **attach-image** control (file picker scoped to `image/png,image/jpeg,image/gif,image/webp`). Selecting a file shows a small pending/preview affordance with a way to remove it before sending.
- [ ] On send, the client uploads the selected file via multipart `POST /api/attachments` with the session token (per `contracts/attachments-rest-api.md`), gets back the `attachmentId`, then sends `message.send { channelId, content, attachmentId }` over the gateway (per `contracts/message-attachment-flow.md`). An **image-only** send (empty text + an image) is allowed; a send with neither text nor an image is blocked client-side.
- [ ] Upload UX: the composer disables/indicates "uploading…" while the POST is in flight, surfaces a friendly error on rejection (oversized, wrong type, network/401) without losing the typed text, and clears the pending image only on success.
- [ ] Client-side guardrails mirror the server: pre-check the file is an allowed image type and under the configured size before uploading (read the limit from the client config layer if available), to fail fast — but the server remains the source of truth.
- [ ] The attachment plumbing uses/extends the existing client types (`client/src/lib/types.ts` — the `attachmentId: number | null` placeholder is replaced/augmented with the embedded `attachment` shape) and the gateway/REST helpers (`client/src/lib/gateway.svelte.ts`, the auth/session layer for the Bearer token); no duplicated fetch/auth logic.
- [ ] `npm run typecheck` (server `tsc` + client `svelte-check`) passes; verifiable by running the client: pick an image, send, and confirm the `message.create` round-trips (rendering is story 005, but the message/attachment arrives) and the file exists server-side.

## Context
`SPEC.md §10`: upload is REST multipart, then `message.send` references the returned id. Builds on story 002 (`POST /api/attachments`) and story 003 (`message.send` attachment rules / image-only content). M2's `story-005-client-message-pane` established the composer and `message.send` path; this extends it. Frontend is Svelte 5 runes; session token comes from the M1 keychain/session layer.

## Out of Scope
- Inline rendering of received images in the message list (story 005).
- Drag-and-drop, clipboard paste, multi-image per message (feature non-goals).
- Any server-side work (stories 001–003).
