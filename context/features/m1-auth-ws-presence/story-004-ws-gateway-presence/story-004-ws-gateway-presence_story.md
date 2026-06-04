---
story: 004
title: WebSocket gateway & presence
status: TODO
depends_on: [001, 003]
provides_contract: contracts/ws-protocol.md
---

#story

# Story 004: WebSocket gateway & presence

## User Story
As a user, I want to connect to the gateway after logging in and see who is online, so that presence updates live across all connected clients.

## Acceptance Criteria
- [ ] A WS endpoint (e.g. `/ws` via `@fastify/websocket` or `ws`) authenticates **on connect** using the session token (reusing story 003's validator). Invalid/expired/revoked → close with a defined auth-failure close code and **no `ready`**.
- [ ] On successful auth the server sends `ready` `{ user, channels: [], members }`, where `members` lists all users with their online status (`channels` stays empty until M2).
- [ ] The server tracks connections per user: the **first** socket for a user broadcasts `presence.update {userId, status:"online", voiceChannelId:null}`; the **last** socket close broadcasts `status:"offline"`.
- [ ] All frames use the `{ "op", "d" }` envelope (`SPEC.md §7`); inbound frames are **size-limited** and unknown ops are ignored safely.
- [ ] A revoked session / `server revoke-user` (story 002) closes the affected user's open sockets and flips presence to offline; at minimum a revoked session cannot establish a new connection.
- [ ] Heartbeat/ping-pong detects dead sockets so presence does not get stuck "online" on an abrupt disconnect.
- [ ] `npm run typecheck` passes; verifiable by connecting two WS clients (e.g. `wscat`/`websocat`) with valid sessions and observing `ready` plus `presence.update` on join/leave.
- [ ] `contracts/ws-protocol.md` documents the connect/auth handshake, the `ready` payload, and `presence.update` for the client (story 007).

## Context
`SPEC.md §7` (envelopes, `ready`, `presence.update`); `§11` voice ops are deferred to M4. Reuses the session validator exported by story 003. With ≤10 clients, a simple in-memory `userId → Set<socket>` map is sufficient — no message broker.

## Out of Scope
- `message.send`/`message.create` and `channel.create` (M2).
- `voice.join`/`voice.leave`/`voice.signal`/`voice.state` (M4).
- Populating `channels` in `ready` — it is an empty placeholder until M2.
