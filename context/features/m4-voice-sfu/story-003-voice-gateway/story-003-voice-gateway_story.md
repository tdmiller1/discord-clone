---
story: 003
title: WS gateway — voice.* signaling & voice presence
status: TODO
depends_on: [001, 002]
provides_contract: contracts/voice-protocol.md
---

#story

# Story 003: WS gateway — voice.* signaling & voice presence

## User Story
As a member, I want to join/leave the voice channel and negotiate media over the existing WebSocket so that the server allocates SFU transports, forwards my mic to others, and shows everyone who is in voice.

## Acceptance Criteria
- [ ] The gateway (`server/src/ws/gateway.ts`) handles the client→server voice ops on **already-authed** sockets, using the `{op,d}` envelope (`SPEC.md §7`): `voice.join {channelId}`, `voice.leave`, `voice.state {muted, deafened}`, and the negotiation op(s) carrying mediasoup params (relayed as `voice.signal` per `§7`, or a small request/response set — document whichever shape is used in the contract). Unknown/invalid voice frames are ignored safely; nothing crashes the socket.
- [ ] `voice.join` validates the target is the **seeded `type:"voice"` channel** (story 001) — a text/unknown channel is rejected and allocates no SFU resources. On success it creates the participant's transports/producer/consumers via the SFU core (story 002) and returns the client what it needs to negotiate (router RTP capabilities + transport params).
- [ ] **Bidirectional consume wiring:** a newly joined participant consumes **all existing** producers in the room, and existing participants are notified (server→client) to consume the **new** producer — no one-way audio.
- [ ] `voice.state {muted}` pauses/resumes the participant's producer; the muted/deafened state is reflected to others as appropriate (e.g. via `voice.state`/`presence.update`).
- [ ] **Voice presence:** an in-memory voice registry (mirroring `PresenceRegistry`) tracks each socket's `voiceChannelId`; joining/leaving broadcasts `presence.update` carrying the live `voiceChannelId` exactly on the transition. `ready`/`buildReady` reports the correct `voiceChannelId` for members already in voice (replacing the hardcoded `null`).
- [ ] **Teardown:** the existing `teardown()` (socket close / error / heartbeat reap) closes the participant's SFU resources, removes it from the room, clears `voiceChannelId`, and broadcasts `presence.update`; other participants are told to drop that peer's consumer. No leaked transports; multi-socket users are handled per the feature edge cases.
- [ ] `npm run typecheck` passes; with `wscat`/`websocat` (or two real clients) a `voice.join` returns valid negotiation params and presence shows the user in voice.
- [ ] `contracts/voice-protocol.md` specifies every voice op (name, direction, `d` payload shape), the join→negotiate→produce→consume sequence, the new-producer/closed-producer notifications, and the `presence.update.voiceChannelId` semantics — the wire contract story 004 implements against.

## Context
The gateway already authenticates on `identify`, maintains `PresenceRegistry` + `BroadcastHub`, broadcasts `presence.update` on online/offline transitions, and runs a single heartbeat that doubles as the revocation reaper — but it explicitly **ignores `voice.*`** ("arrives in M4") and `buildReady` hardcodes `voiceChannelId: null`. `Member`/`PresenceUpdatePayload` already carry `voiceChannelId` (`server/src/types.ts`). This story turns those stubs live by relaying the SFU core (story 002) over the WS for the seeded voice channel (story 001).

## Out of Scope
- mediasoup internals (story 002 owns the SFU service; this story only relays it).
- Seeding the voice channel (story 001).
- Any client WebRTC / `mediasoup-client` (story 004) or UI (story 005).
- Persisting voice state (voice is ephemeral — no data-model changes).
