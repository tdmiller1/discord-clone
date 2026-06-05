---
story: 005
title: "Client: render attachments inline in the message pane"
status: TODO
depends_on: [002, 003]
provides_contract:
---

#story

# Story 005: Client — render attachments inline in the message pane

## User Story
As a member, I want images to display inline in the message list, so that I can see what others share without leaving the app, both live and after a reload.

## Acceptance Criteria
- [ ] The message list (`client/src/lib/MessagePane.svelte`) renders an inline image for any message whose `attachment` is non-null — for both **live** `message.create` and **reloaded history** (`GET /api/channels/:id/messages`), structurally identical and deduped by message `id`.
- [ ] Because `GET /api/attachments/:id` is **auth-checked** and a `<img src>` cannot send a Bearer header, the client fetches the bytes with the session token and renders via an **object URL** (`URL.createObjectURL`), revoking it on unmount/replacement to avoid leaks; a thin helper (e.g. in `client/src/lib/` alongside the messages store) encapsulates fetch→blob→object-URL and caches by attachment id so re-renders/scrollback don't re-fetch.
- [ ] Images are scaled for display with CSS only (max width/height, preserve aspect ratio — no server thumbnails per the feature non-goal); width/height from the `PublicAttachment` may be used to reserve layout space and avoid reflow.
- [ ] Loading and failure states are handled: a placeholder/spinner while the blob loads, and a graceful "image unavailable" affordance on `401`/`404`/network error (never a broken-image crash or unhandled rejection).
- [ ] Image-only messages (empty `content`) render cleanly (just the image, no empty text line); messages with both text and an image render both.
- [ ] **Survives reload** (the M3 acceptance bar, `SPEC.md §14`): relaunching/reconnecting the client re-fetches history and the previously-posted images reappear inline.
- [ ] `npm run typecheck` (server `tsc` + client `svelte-check`) passes; verifiable by running two clients: one posts an image (story 004), the other sees it inline live; reloading either client shows the image from persisted history.

## Context
`SPEC.md §10`: "Client renders images inline in the message list." Builds on story 002 (`GET /api/attachments/:id`, auth-checked) and the embedded `attachment` on `message.create`/history from stories 001/003. Extends M2's `story-005-client-message-pane` rendering and the messages store (`client/src/lib/messages.ts`/`MessagePane.svelte`). The object-URL approach is required by the Bearer-auth download (a bare `<img src>` would 401).

## Out of Scope
- The compose/upload side (story 004).
- Lightbox/zoom, downloads-to-disk, galleries, video (feature non-goals).
- Any server-side work (stories 001–003).
