---
story: 004
title: "Client: channel list, selection & create-channel"
status: TODO
depends_on: [002, 003]
provides_contract: contracts/client-channel-state.md
---

#story

# Story 004: Client — channel list, selection & create-channel

## User Story
As a user, I want to see the list of text channels, select one, and create a new channel, so that I can pick where to talk and add channels.

## Acceptance Criteria
- [ ] After the gateway connects (M1 `story-007-client-presence-ui`), the client renders a **channel list** from `ready.channels` and appends new channels live on `channel.create` (story 002), deduped by `id`.
- [ ] Selecting a channel sets a shared **active-channel** state (Svelte 5 runes) that the message pane (story 005) consumes; the selected channel is visually indicated. A sensible default channel is selected on first load when any exist.
- [ ] A **create-channel** control collects a name and calls `POST /api/channels { name, type: "text" }` (story 003) with the Bearer session; on success the new channel appears (via `channel.create` and/or the response, deduped) and can be selected. Validation/`4xx` errors are surfaced to the user; the input is cleared on success.
- [ ] Only `type: "text"` channels are listed/selectable in M2; any `voice` channels are hidden or shown disabled (voice is M4).
- [ ] `npm run typecheck` (server `tsc` + client `svelte-check`) passes; verifiable in the running client: create a channel, see it appear in the list (and on a second client live), and select it.
- [ ] `contracts/client-channel-state.md` documents the active-channel store/selection API and the channel shape the message pane (story 005) consumes.

## Context
The client already connects to the gateway and handles `ready`/presence (M1 story 007). M2 adds channels to `ready` (story 002) and a create endpoint (story 003). UI follows the existing Svelte 5 runes style (`$state`) in `client/src/`; the Bearer session token comes from the keychain/session layer (M1 stories 005–006).

## Out of Scope
- Rendering messages, the composer, and history fetching (story 005) — this story only owns the channel list, selection state, and channel creation.
- Channel rename/delete/reorder UI.
- Voice channel join UI (M4).
