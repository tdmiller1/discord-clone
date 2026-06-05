---
story: 005
title: Client — voice channel UI, join/leave, mute & in-voice presence
status: TODO
depends_on: [004]
provides_contract:
---

#story

# Story 005: Client — voice channel UI, join/leave, mute & in-voice presence

## User Story
As a member, I want to see the voice channel, join/leave it with a button, mute myself, and see who else is in voice so that talking is as obvious as texting.

## Acceptance Criteria
- [ ] The **voice channel is rendered** in the channel list — the current `type === "text"` filter in `client/src/lib/gateway.svelte.ts`'s `_channelList` (and the channel-list component) is extended so the seeded voice channel appears, visually distinct from text channels and not selectable as a message pane.
- [ ] A **Join** control on the voice channel calls the voice engine's `join()` (story 004); while in voice it becomes **Leave** and calls `leave()`. Join surfaces a clear error if mic permission is denied or the connection fails.
- [ ] An **in-voice participant list** shows who is currently in the voice channel (derived from `presence.update`/`ready` `voiceChannelId`), updating live as people join/leave.
- [ ] A **mute** toggle (and optional deafen) reflects and drives the engine's `muted` state; the user's own muted state is visible.
- [ ] **Member-list voice indicator:** members in voice are marked in the existing presence list (`client/src/lib/Presence.svelte` / members map), driven by `voiceChannelId`.
- [ ] Switching between text channels and the message pane still works (voice is a parallel control, not a message view); the active-channel/message-pane behavior from M2 is unaffected.
- [ ] `npm run typecheck` (incl. `svelte-check`) passes; running two clients shows both the voice channel and, after joining, each other in the in-voice list with mute reflected.

## Context
M2's client filters voice channels **out** of the list (`_channelList` keeps only `type === "text"`). `Member`/`presence.update` already carry `voiceChannelId`, and `Presence.svelte` renders the members map — this story makes both voice-aware. All audio/transport logic lives in the story-004 voice store; this story is presentation + wiring to its reactive API (`contracts/voice-store.md`).

## Out of Scope
- WebRTC / `mediasoup-client` mechanics (story 004 owns the engine).
- Server SFU / gateway / seeding (stories 001–003).
- Multiple voice channels, channel management, speaking indicators / VAD, per-user volume (non-goals).
