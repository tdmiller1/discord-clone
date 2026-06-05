---
name: M4 — Voice (SFU)
description: One server-routed (mediasoup SFU-lite) voice channel — clients publish an Opus mic track, the server forwards it to other participants; mute works and presence shows who's in voice.
type: feature
status: planned
completed_date:
---

# Feature: M4 — Voice (SFU)

## Problem Statement
After M1–M3 the ~10 users can authenticate, see presence, chat in text channels, and share inline images — but there is no way to *talk*. SPEC's core feature set (`§1`) promises "one basic VOIP channel," and the seams for it are already stubbed everywhere but inert: `config` reserves `rtcMinPort`/`rtcMaxPort`/`publicHost` for the SFU, every `Member`/`presence.update` carries a `voiceChannelId` that is **always `null`**, the WS gateway explicitly **ignores `voice.*` ops** ("arrives in M4"), and the client's channel list **filters voice channels out** ("voice is M4"). Nothing actually moves audio.

## Goal
Deliver the M4 acceptance loop from `SPEC.md §14`: **two clients join the voice channel and hear each other; mute works; presence shows who's in.** Concretely — a single default **voice channel** appears in the channel list; clicking **Join** runs `getUserMedia` for the mic, negotiates with the server SFU over the WS `voice.*` ops, and **publishes one Opus track**; the server (mediasoup, `SPEC.md §13.1`) **forwards each participant's track to the others** in that channel (selective forwarding, no client-side mesh — `§11`); each participant hears the others via an inline `<audio>` element. A **mute** toggle pauses the outbound producer; **leave / disconnect** tears down the transports and clears voice presence; `presence.update` carries the live `voiceChannelId` so every client shows who is in voice.

## Constraints
- **Server-routed SFU-lite (`SPEC.md §11`):** all audio flows through the server, which forwards each speaker's Opus stream to the other participants. **No client-side mesh.** SFU is **mediasoup** (`§13.1`) — install `mediasoup` (server) + `mediasoup-client` (webview). Opus is the only negotiated codec; media is **DTLS-SRTP** encrypted by default (`§12`).
- **Reuse the reserved config — don't add a parallel path.** `loadConfig()` (`server/src/config.ts`) already exposes `rtcMinPort`/`rtcMaxPort` (the mediasoup `WebRtcTransport` UDP port range) and `publicHost` (the **ICE announced address**). The mediasoup worker's `rtcMinPort`/`rtcMaxPort` and the transport's `announcedIp` must come from these — no scattered `process.env`. Keep `docker-compose.yml`'s **UDP media port range in sync** with `RTC_MIN_PORT`–`RTC_MAX_PORT` (CLAUDE.md gotcha) and ensure the Docker image can run the mediasoup prebuilt worker.
- **Voice signaling rides the existing WS gateway, not a second socket.** The `voice.*` ops use the `{ "op", "d" }` envelope (`SPEC.md §7`); only sockets that completed the M1 `identify` handshake may send them; inbound frames stay size-limited; unknown/invalid ops are ignored safely. Extend `server/src/ws/gateway.ts` and reuse the heartbeat/teardown path — a dropped socket must release its SFU resources and clear voice presence in the same `teardown()`.
- **Voice membership is in-memory, mirroring presence (`≤10 clients, no broker`).** Track who is in the voice channel (and their mediasoup transports/producer/consumers) in an in-memory registry alongside `PresenceRegistry`/`BroadcastHub`. Setting/clearing a user's `voiceChannelId` re-broadcasts `presence.update` exactly on the join/leave transition (mirror the first-online/last-offline pattern).
- **Single voice channel for v1 (`SPEC.md §13.3`).** The data model already supports N voice channels (`channels.type = 'text'|'voice'`); M4 **seeds exactly one** default voice channel idempotently on boot and the UI/SFU expose **one room**. M2's create endpoint rejects `type:"voice"` — that stays; voice channels are not user-created in v1.
- **Voice is ephemeral — nothing is persisted.** There are no voice rows in the data model (`SPEC.md §8`): no call history, no recordings. Voice membership lives only in memory and resets on server restart.
- **Server is ESM** (`"type": "module"`, NodeNext) — relative TS imports carry the `.js` extension. Frontend is **Svelte 5 runes** (`$state`, …); the webview owns WebRTC via `getUserMedia`/`RTCPeerConnection` (wrapped by `mediasoup-client`'s `Device`). **No test runner exists** — `npm run typecheck` is the only static gate; acceptance is verified by running two clients and confirming two-way audio + mute + presence.

## Non-Goals
- **More than one concurrent voice channel.** Data supports N; v1 limits the UI/SFU to a single room (`SPEC.md §13.3`). User-created voice channels stay out (the create endpoint keeps rejecting `voice`).
- **Video / screen share** (`SPEC.md §2`) — audio only.
- **External TURN / STUN.** Because audio is server-routed and the host exposes the media UDP range directly, no external TURN is required (`SPEC.md §11`); the server's `publicHost` is the ICE announce address.
- **Voice activity detection, push-to-talk, noise suppression, per-user volume sliders, speaking indicators.** Not in the spec. (A basic local **deafen** — muting inbound playback — may ride `voice.state` but a rich UI is out of scope; **mute** is the required control.)
- **Multi-device voice fan-out polish.** A user with multiple sockets is an edge case to handle safely (see below), not a feature to optimize.
- **Recording / call history / voicemail / ringing / DMs-to-voice.** No persistence (`SPEC.md §8` has no voice tables).
- **Roles / permissions** — any member can join the voice channel (one flat member role, `SPEC.md §2`).

## Known Edge Cases
- **Mic permission denied / no input device:** `getUserMedia` rejects → surface a clear error and do **not** half-join (no producer, no `voice.join` committed, presence stays out of voice).
- **Join a non-voice or nonexistent channel:** `voice.join` for a `type:"text"` channel or an unknown `channelId` is rejected/ignored — never allocates SFU resources.
- **New participant joins an ongoing call:** existing participants must start **consuming** the newcomer's producer (server announces the new producer so each peer issues a `consume`), and the newcomer must consume **all** existing producers — both directions wired, no silent one-way audio.
- **Leave / disconnect / socket drop / heartbeat reap mid-call:** the same `teardown()` closes the transports + producer + consumers, removes the participant from the room, clears `voiceChannelId`, and broadcasts `presence.update`; other participants close the consumer for that peer and drop its `<audio>` element. No leaked mediasoup transports when the last participant leaves.
- **Double join / re-join:** a `voice.join` while already in voice is idempotent or leave-then-join — never produces two mic tracks for one socket.
- **Mute toggled rapidly:** `voice.state {muted}` pauses/resumes the producer consistently; rapid toggles converge to the final state; remote peers may reflect speaking state but audio simply stops/starts.
- **ICE/DTLS failure** (media UDP range not exposed, NAT, wrong `announcedIp`): the transport's connection state goes `failed`/`disconnected` → surfaced to the user; the UI doesn't wedge and Leave still cleans up.
- **Server restart while in a call:** clients see the WS reconnect (existing M1 backoff); voice state is **not** restored — the user must re-Join (membership was in-memory only).
- **Multi-socket user:** the same user on two sockets — presence shows the user in voice if **any** socket is in voice; each in-voice socket is its own SFU participant; teardown of one socket must not clear the other's audio.
- **Reconnect race:** a `presence.update` (voiceChannelId) the client missed while offline is reconciled from the `ready` snapshot's `members[].voiceChannelId` on reconnect.

## User Stories

| # | Story Directory | Title | Status |
|---|----------------|-------|--------|
| 1 | story-001-voice-channel-seed | Server: seed & expose the single voice channel | TODO |
| 2 | story-002-sfu-core | Server: mediasoup SFU core (worker, router, voice rooms) | TODO |
| 3 | story-003-voice-gateway | WS gateway: voice.* signaling & voice presence | TODO |
| 4 | story-004-client-voice-engine | Client: mediasoup-client voice engine (publish/consume/mute) | TODO |
| 5 | story-005-client-voice-ui | Client: voice channel UI, join/leave, mute & in-voice presence | TODO |
