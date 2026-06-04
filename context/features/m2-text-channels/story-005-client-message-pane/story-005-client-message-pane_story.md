---
story: 005
title: "Client: message history, composer & live updates"
status: TODO
depends_on: [002, 003, 004]
provides_contract:
---

#story

# Story 005: Client — message history, composer & live updates

## User Story
As a user, I want to read a channel's history and send messages that appear live for everyone, so that I can hold a conversation that is still there after I reload — closing the M2 end-to-end goal.

## Acceptance Criteria
- [ ] When the active channel (story 004) changes, the client fetches recent history via `GET /api/channels/:id/messages?limit=50` (story 003) and renders messages oldest→newest, resolving each author's display name from the `members` map delivered in `ready` (M1); an author missing from the map degrades gracefully (e.g. shows the id).
- [ ] A **composer** sends `message.send { channelId, content }` over the WS (story 002) for the active channel; the input clears on send; empty/whitespace or over-max-length content is prevented client-side.
- [ ] Incoming `message.create` for the active channel is appended live without reload; messages for non-active channels are cached/updated without disrupting the current view; messages are **deduped by `id`** so a history/live race renders each once.
- [ ] Older messages can be loaded via the `before` keyset cursor (story 003) — at minimum the most-recent page renders, with a "load older" affordance when more exist.
- [ ] **Persistence across reload/reconnect:** after relaunching the client (or dropping and reconnecting the WS), the channel list and the active channel's message history are shown from the server (`ready.channels` + the history fetch) — satisfying the M2 acceptance ("reload shows persisted history").
- [ ] Content is rendered as **plain text** (no markdown/mentions); attachments are not rendered (M3).
- [ ] `npm run typecheck` passes; verifiable with two running clients: messages sent from one appear live in the other and in the sender, and reloading either client shows the persisted history.

## Context
This closes the M2 loop on the client. It consumes the active-channel state (story 004 `contracts/client-channel-state.md`), the WS `message.send`/`message.create` ops (story 002 `contracts/ws-messaging.md`), and the history endpoint (story 003 `contracts/channels-rest-api.md`). Uses Svelte 5 runes and the existing gateway/session layers from M1.

## Out of Scope
- Channel list/selection/creation (story 004).
- Inline image rendering and uploads (M3); markdown/mentions formatting; edit/delete/reactions/replies; typing indicators and unread badges.
