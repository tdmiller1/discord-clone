---
story: 002
title: Server — mediasoup SFU core (worker, router, voice rooms)
status: TODO
depends_on: []
provides_contract: contracts/sfu-core.md
---

#story

# Story 002: Server — mediasoup SFU core (worker, router, voice rooms)

## User Story
As the gateway, I want a framework-agnostic SFU service that owns mediasoup and exposes a small per-participant API so that I can negotiate transports and forward Opus tracks without touching mediasoup internals.

## Acceptance Criteria
- [ ] `mediasoup` is added to `server/package.json`; a `VoiceSfu` (or similar) service initializes a mediasoup **Worker** and a **Router** carrying the **Opus** codec, using `config.rtcMinPort`/`config.rtcMaxPort` for the worker RTC port range — **no scattered `process.env`** (`server/src/config.ts` only).
- [ ] A **per-voice-channel room** abstraction tracks participants; each participant owns its mediasoup `WebRtcTransport`(s) (send + recv), one audio **producer**, and the **consumers** of the other participants' producers. The service exposes a minimal API the gateway calls: get router RTP capabilities, create a WebRTC transport (returning client connect params), connect a transport (DTLS), produce (mic), consume (a given producer), pause/resume a producer (mute), list existing producers in a room, and close/cleanup a participant.
- [ ] `WebRtcTransport` is created with `listenIps` using `config.publicHost` as the **`announcedIp`** (ICE announce address, `SPEC.md §11`); media is DTLS-SRTP by default.
- [ ] The service is **framework-agnostic** (no Fastify import), mirroring `BroadcastHub`/`PresenceRegistry`, so it can be constructed in `buildApp` and reasoned about independently. It is created once and shared.
- [ ] Cleanup is correct and leak-free: closing a participant closes its transports/producer/consumers; an empty room releases its resources; worker/router are closed on app `onClose`.
- [ ] `npm run typecheck` passes; the worker starts without binding errors when the RTC port range is available; the Docker image can run mediasoup's prebuilt worker (note any build deps in the Dockerfile).
- [ ] `contracts/sfu-core.md` documents the service's public method signatures and the data shapes it returns (router RTP capabilities, transport params, producer/consumer ids) — the exact objects the gateway will relay to clients (story 003).

## Context
`SPEC.md §11` defines SFU-lite: clients publish an Opus track; the server forwards each participant's track to the others (selective forwarding, no mesh). `§13.1` selects **mediasoup**. The existing in-memory collaborators (`server/src/ws/hub.ts`, `server/src/ws/presence.ts`) are the pattern to mirror: plain classes, no framework coupling, blessed for ≤10 clients with no broker. `config.rtcMinPort`/`rtcMaxPort`/`publicHost` already exist and are reserved for exactly this.

## Out of Scope
- Any WebSocket wiring or `voice.*` op handling (story 003 consumes this service).
- Presence / `voiceChannelId` broadcasting (story 003).
- The voice channel row itself (story 001).
- Client-side mediasoup-client / WebRTC (story 004).
