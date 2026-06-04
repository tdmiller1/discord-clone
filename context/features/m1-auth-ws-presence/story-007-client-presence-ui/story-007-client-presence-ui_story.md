---
story: 007
title: "Client: gateway connection & live presence"
status: TODO
depends_on: [004, 006]
provides_contract:
---

#story

# Story 007: Client — gateway connection & live presence list

## User Story
As a user, I want to see the member list with who is online updating live, so that I know who is around — closing the M1 end-to-end goal.

## Acceptance Criteria
- [ ] After login (story 006 session/state), the client opens the WS to the server and authenticates with the stored session token per the handshake (story 004).
- [ ] On `ready`, it renders the member list from `members` with online/offline indicators (including the current user).
- [ ] On `presence.update`, it updates the corresponding member's status **live, without reload**.
- [ ] Connection lifecycle is handled: auto-reconnect with backoff on drop; on an auth-failure close (revoked/expired session) it clears the session and returns to login (story 006).
- [ ] Frames are parsed/sent as `{ "op", "d" }` envelopes (story 004 contract).
- [ ] Built with Svelte 5 runes; `npm run typecheck` passes; **end-to-end verifiable**: two clients log in and each sees the other flip online/offline live (the M1 acceptance in `SPEC.md §14`).

## Context
`SPEC.md §7`/`§14`. This story consumes the `ws-protocol` contract (004) and the `client-session` contract (006) and closes the M1 acceptance loop.

## Out of Scope
- Channel/message rendering (M2).
- Voice UI (M4).
