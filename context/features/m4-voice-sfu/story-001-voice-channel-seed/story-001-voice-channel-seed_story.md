---
story: 001
title: Server — seed & expose the single voice channel
status: TODO
depends_on: []
provides_contract: contracts/voice-channel.md
---

#story

# Story 001: Server — seed & expose the single voice channel

## User Story
As a member, I want a single voice channel to exist and appear in my channel list so that there is somewhere to join voice, without anyone having to create it.

## Acceptance Criteria
- [ ] On server boot, exactly one `type:"voice"` channel is **seeded idempotently** (`CREATE`-if-absent; a restart does not create a second one). Name and seeding live in a clear place (e.g. a `seedVoiceChannel(db)` reachable from `buildApp`/startup, reusing `server/src/channels.ts` helpers).
- [ ] The seeded voice channel is returned in `ready.channels` (it already flows through `listChannels` → `toPublicChannel`) with `type:"voice"`, so existing clients receive it with no gateway change.
- [ ] M2 invariants are preserved: `POST /api/channels` still **rejects `type:"voice"`** (voice channels are not user-created in v1); duplicate-name rules unchanged.
- [ ] `getChannelById` / channel lookups distinguish `text` vs `voice` so a later story can validate that `voice.join` targets a voice channel.
- [ ] `npm run typecheck` passes; `curl`-ing the channel list / inspecting `ready` shows the voice channel present once after one or more restarts.
- [ ] `contracts/voice-channel.md` records: how the single voice channel is identified (its `type:"voice"` row, single-room invariant), its shape in `ready.channels`, and the guarantee that exactly one exists — for stories 003 and 005.

## Context
The data model already supports voice channels (`channels.type = 'text'|'voice'`, `SPEC.md §8`) and `toPublicChannel` already emits `type`. M2 deliberately created/rendered only text channels and the create endpoint rejects `voice`. `SPEC.md §13.3` confirms **a single voice channel for v1** — so rather than build voice-channel creation UI, M4 seeds one default voice channel on boot.

## Out of Scope
- The SFU engine, transports, or any `voice.*` gateway handling (stories 002/003).
- Any client rendering of the voice channel (story 005 — the client currently filters voice out).
- User-created or multiple voice channels (non-goal: single room v1).
