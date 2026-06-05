---
story: 004
title: Client — mediasoup-client voice engine (publish/consume/mute)
status: TODO
depends_on: [003]
provides_contract: contracts/voice-store.md
---

#story

# Story 004: Client — mediasoup-client voice engine (publish/consume/mute)

## User Story
As a member, I want the client to capture my mic, publish it to the server SFU, and play back the other participants so that joining the voice channel results in real two-way audio I can mute.

## Acceptance Criteria
- [ ] `mediasoup-client` is added to `client/package.json`; a reactive voice engine lives in a `*.svelte.ts` module (Svelte 5 runes, mirroring `gateway.svelte.ts`) so socket-independent state survives re-renders and has one teardown point.
- [ ] **Join:** run `getUserMedia({audio:true})` for the mic, load a mediasoup `Device` with the router RTP capabilities from `voice.join`, create send + recv `Transport`s from the returned params, wire transport `connect`/`produce` events back over the WS per `contracts/voice-protocol.md`, and **produce** the Opus mic track.
- [ ] **Consume:** consume every existing producer the server reports on join, and consume each **new** producer announced while in the call; attach each remote track to an `<audio>` element (or expose remote `MediaStream`s for the UI) so the user hears the others. Handle server **producer-closed**/peer-leave notifications by closing that consumer and dropping its audio.
- [ ] **Mute:** a mute toggle pauses the local producer and sends `voice.state {muted}`; unmute resumes. Optional local **deafen** mutes inbound playback. Rapid toggles converge.
- [ ] **Leave / teardown:** sends `voice.leave`, closes the producer/consumers/transports and stops the mic tracks (mic indicator off); a WS disconnect/auth-fail (reuses gateway state) also tears voice down cleanly. No dangling `MediaStream`s or transports.
- [ ] Mic-permission denial and transport `failed`/`disconnected` states are surfaced as reactive error/connection state (not thrown into the void), and leave still cleans up — per the feature edge cases.
- [ ] `npm run typecheck` (incl. `svelte-check`) passes; running **two clients** and joining yields audible two-way audio with working mute and clean leave.
- [ ] `contracts/voice-store.md` documents the reactive API the UI consumes: connection/voice status, current `voiceChannelId`, participant list, `muted`/`deafened`, error state, and the `join()`/`leave()`/`toggleMute()` (and optional `toggleDeafen()`) actions.

## Context
The client already owns a reactive WS gateway (`client/src/lib/gateway.svelte.ts`) handling `identify`, `ready`, `presence.update`, reconnect/backoff, and the 4001 auth-fail flag — voice negotiation rides the **same socket** via the `voice.*` ops defined in story 003's contract. `SPEC.md §4`/`§11`: the webview owns WebRTC (`getUserMedia`/`RTCPeerConnection`), here wrapped by `mediasoup-client`'s `Device`/`Transport`. Client publishes one Opus track; the server forwards — no client mesh.

## Out of Scope
- Server SFU / gateway (stories 002/003 — this story consumes the WS protocol).
- Rendering the voice channel, join/leave buttons, participant list, or presence indicators in components (story 005 — this story exposes the reactive store/actions only).
- Voice channel seeding (story 001).
