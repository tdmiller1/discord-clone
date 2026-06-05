#plan

# Plan: Client — mediasoup-client voice engine (publish/consume/mute)

## Summary
Add a reactive `voice.svelte.ts` runes-module that captures the mic, drives the
mediasoup-client `Device`/`Transport`/`Producer`/`Consumer` lifecycle over the **existing**
gateway socket via a narrow `sendVoice`/`onVoiceFrame` seam, and exposes a UI-facing store
(status, `voiceChannelId`, participants, `muted`/`deafened`, error, `join`/`leave`/`toggleMute`/
`toggleDeafen`) consumed by story 005 — with voice teardown wired into the gateway's disconnect
and 4001 paths.

## Implementation Steps

### Step 1: Add `mediasoup-client` dependency
**File(s):** `client/package.json`
**Action:** modify
**Description:** Add `mediasoup-client` to `dependencies` (the one new runtime dep). Pin a
mediasoup-client v3 range (e.g. `^3.7.0`) compatible with the server's mediasoup major. Run
`npm install` so the lockfile resolves and `svelte-check`/`tsc` can see its types.
**Diff shape:**
- Add `"mediasoup-client": "^3.7.0"` under `dependencies`.

### Step 2: Extend WS frame types with the `voice.*` envelopes
**File(s):** `client/src/lib/types.ts`
**Action:** modify
**Description:** Add payload interfaces for every server→client `voice.*` frame (mirroring the
contract verbatim) and extend the `ServerFrame` discriminated union with them so `handleFrame`
type-narrows. mediasoup param fields (`rtpCapabilities`, `iceParameters`, `iceCandidates`,
`dtlsParameters`, `rtpParameters`) stay `unknown` per Decision 5. Also add the client→server
`voice.*` payload types so the engine can build typed frames, and update the
`Member.voiceChannelId` / `PresenceUpdatePayload.voiceChannelId` doc comments (no longer "always
null in M1"; voice arrives in M4).
**Diff shape:**
- Add `VoiceJoinedPayload`, `VoiceTransportPayload`, `VoiceConnectedPayload`,
  `VoiceProducedPayload`, `VoiceConsumerPayload`, `VoiceResumedPayload`,
  `VoiceNewProducerPayload`, `VoicePeerLeftPayload`, `VoiceStateUpdatePayload`,
  `VoiceErrorPayload` interfaces.
- Add client→server payload types: `VoiceJoinPayload`, `VoiceTransportRequestPayload`,
  `VoiceConnectPayload`, `VoiceProducePayload`, `VoiceConsumePayload`, `VoiceResumePayload`,
  `VoiceStatePayload`, `VoiceLeavePayload`.
- Add the 10 server→client voice envelopes to the `ServerFrame` union
  (`Envelope<"voice.joined", VoiceJoinedPayload>`, etc.; note `voice.transport` and
  `voice.state` are distinct ops from any existing).
- Change `Member.voiceChannelId` and `PresenceUpdatePayload.voiceChannelId` comments.

### Step 3: Add the gateway voice seam (send + inbound frame route + teardown signal)
**File(s):** `client/src/lib/gateway.svelte.ts`
**Action:** modify
**Description:** Open three narrow seams so the voice engine rides the same socket without
exposing the raw WS (Decision 1 & 2):
1. **Send:** add `sendVoice(op, d)` to the exported `gateway` object — guards
   `socket !== null && socket.readyState === WebSocket.OPEN`, then
   `socket.send(JSON.stringify({ op, d }))`, mirroring `sendMessage`. Returns `boolean`
   (whether it was sent) so the engine can fail a join if the socket dropped.
2. **Inbound route:** add a module-local `voiceFrameHandler: ((frame: ServerFrame) => void) | null`
   and an `onVoiceFrame(handler)` registration on the `gateway` object. In `handleFrame`, route
   any frame whose `op` starts with `"voice."` (replace the silent `default` for those) to the
   registered handler if set. Keep non-voice unknown ops on `default: break`.
3. **Teardown signal:** add a module-local `voiceTeardownHandler: (() => void) | null` and an
   `onVoiceTeardown(handler)` registration. Invoke it inside `disconnect()` (intentional logout/
   unmount) and in the `onclose` 4001 branch (before setting `_authFailed`), so a dropped/auth-
   failed socket releases the mic + transports from one place.
4. **Presence threading (Decision 3):** in the `presence.update` case, also copy
   `voiceChannelId` onto the member (`{ ...existing, status: frame.d.status,
   voiceChannelId: frame.d.voiceChannelId }`) so the "who's in voice" set is reactive; the
   `ready` handler already stores members verbatim.
**Diff shape:**
- Add `voiceFrameHandler` / `voiceTeardownHandler` module locals.
- Add a `voice.`-prefix branch in `handleFrame` dispatching to `voiceFrameHandler`.
- Update the `presence.update` case to thread `voiceChannelId`.
- Invoke `voiceTeardownHandler?.()` in `disconnect()` and the 4001 `onclose` branch.
- Add `sendVoice`, `onVoiceFrame`, `onVoiceTeardown` to the exported `gateway` object.

### Step 4: Create the reactive voice engine
**File(s):** `client/src/lib/voice.svelte.ts`
**Action:** create
**Description:** The `provides_contract` deliverable. A runes-module singleton mirroring
`gateway.svelte.ts`: module-level `$state` for `voiceStatus`, `voiceChannelId`, `participants`,
`muted`, `deafened`, `error`; **non-reactive** module locals for the mediasoup `Device`, send/
recv `Transport`s, the local `Producer`, a `Map<producerId, Consumer>`, the mic `MediaStream`,
a `Map<participantId, string[]>` (producerIds per peer, for `voice.peer_left`), a
`Map<producerId, HTMLAudioElement>` (programmatic playback — Decision 4 option a), and pending-
promise resolvers for the request/reply ops that have no transport-event callback
(`voice.joined`, `voice.transport`, `voice.connected`, `voice.produced`). At module load it
registers `gateway.onVoiceFrame(handleVoiceFrame)` and `gateway.onVoiceTeardown(teardown)`.

Implements the full negotiation per the contract / research Data Flow:
- **`join(channelId)`** — set status `joining`; `getUserMedia({ audio:true })` (catch → set
  `error`, status back to `idle`, do **not** commit join); idempotency guard (no-op or leave-
  then-join if already in a call); `sendVoice("voice.join", { channelId })`; await `voice.joined`
  → store `participantId`, set `voiceChannelId`, `await device.load({ routerRtpCapabilities })`;
  request both transports (`voice.transport {direction}`) and on each reply
  `device.createSend/RecvTransport(...)`; wire transport `"connect"` (→ `voice.connect`, resolve
  on `voice.connected`), send-transport `"produce"` (→ `voice.produce`, resolve `cb({id})` on
  `voice.produced`), and `connectionstatechange` (`failed`/`disconnected` → reactive `error` +
  status); `sendTransport.produce({ track: micTrack })` → store `Producer`; consume each
  `voice.joined.producers` entry via the shared consume helper; set status `connected`.
- **`consumeProducer(participantId, producerId)`** helper — `sendVoice("voice.consume",
  { producerId, rtpCapabilities: device.rtpCapabilities })`; on `voice.consumer` →
  `recvTransport.consume(...)`, store `Consumer` by producerId, build a `MediaStream` + an
  `HTMLAudioElement` (autoplay, `muted = _deafened`), record `participantId → producerId`, add/
  update the participant in the reactive list, then `sendVoice("voice.resume", { producerId })`.
  A `voice.consume` with no `voice.consumer` reply is a silent skip (caps-incompatible).
- **`handleVoiceFrame(frame)`** — switch on `frame.op`: `voice.joined`/`voice.transport`/
  `voice.connected`/`voice.produced` resolve their pending promises; `voice.consumer`/
  `voice.resumed` feed the consume helper; `voice.new_producer` → `consumeProducer(...)`;
  `voice.peer_left` → close that participant's consumer(s), stop/remove its `<audio>`, drop from
  maps + participant list; `voice.state` → update that participant's reactive `muted`/`deafened`;
  `voice.error` → set reactive `error` (and unblock any pending join promise).
- **`toggleMute()`** — flip `_muted` to the final boolean, `producer.pause()`/`resume()`,
  `sendVoice("voice.state", { muted: _muted, deafened: _deafened })`. Convergent under rapid
  toggles (state set before send).
- **`toggleDeafen()`** — flip `_deafened`, set `audio.muted = _deafened` on every playback
  element, relay `sendVoice("voice.state", { muted: _muted, deafened: _deafened })`.
- **`leave()` / `teardown()`** — single teardown point: if in a call `sendVoice("voice.leave",
  {})`; close `producer`, every `consumer`, both `transport`s; stop every mic track + drop the
  `MediaStream`; pause/remove every `<audio>` element; null the `Device`; clear all maps and
  reset reactive state (`voiceStatus = "idle"`, `voiceChannelId = null`, `participants = []`,
  `muted = false`, `deafened = false`). `teardown()` is what the gateway's
  `onVoiceTeardown` invokes (skips the `voice.leave` send since the socket is already gone).
Reassign participant `$state` arrays/derived maps after each mutation (Svelte 5 reactivity).
**Diff shape:**
- New file: reactive `$state` + non-reactive mediasoup locals + the exported `voice` singleton.

### Step 5: Wire voice teardown into App's logout / session-invalid (belt-and-suspenders)
**File(s):** `client/src/App.svelte`
**Action:** modify
**Description:** The gateway `onVoiceTeardown` hook (Step 3) already fires voice teardown on
`disconnect()` and 4001. For symmetry with the existing `channelStore.clear()` /
`clearAttachmentImages()` cleanup and to guarantee teardown even if the socket never opened,
call `voice.leave()` in `handleLogout` and `voice.teardown()` in `handleSessionInvalid`
(idempotent — safe to call when not in a call). Import the `voice` singleton.
**Diff shape:**
- Add `import { voice } from "./lib/voice.svelte";`.
- Call `voice.leave()` in `handleLogout`, `voice.teardown()` in `handleSessionInvalid`.

### Step 6: Author the voice-store contract
**File(s):** `context/features/m4-voice-sfu/story-004-client-voice-engine/contracts/voice-store.md`
**Action:** create
**Description:** Document the reactive API story 005's UI consumes: `voiceStatus`,
`voiceChannelId`, `participants` (with per-participant `participantId`/`userId`/`muted`/
`deafened`), `muted`, `deafened`, `error`, and the `join(channelId)`/`leave()`/`toggleMute()`/
`toggleDeafen()` actions — including their signatures, semantics, and teardown guarantees.
This satisfies the last acceptance criterion and the story's `provides_contract` frontmatter.
**Diff shape:**
- New markdown contract mirroring "New Types / Schemas / Contracts" below.

## New Types / Schemas / Contracts

**New TS payload types (`types.ts`)** — server→client: `VoiceJoinedPayload`,
`VoiceTransportPayload`, `VoiceConnectedPayload`, `VoiceProducedPayload`, `VoiceConsumerPayload`,
`VoiceResumedPayload`, `VoiceNewProducerPayload`, `VoicePeerLeftPayload`,
`VoiceStateUpdatePayload`, `VoiceErrorPayload`; client→server: `VoiceJoinPayload`,
`VoiceTransportRequestPayload`, `VoiceConnectPayload`, `VoiceProducePayload`,
`VoiceConsumePayload`, `VoiceResumePayload`, `VoiceStatePayload`, `VoiceLeavePayload`. All
mediasoup param fields typed `unknown`. The 10 server frames are added to `ServerFrame`.

**Voice store internal types (`voice.svelte.ts`):**
```ts
type VoiceStatus = "idle" | "joining" | "connected" | "error";

interface VoiceParticipant {
  participantId: string;
  userId: number | null;   // known once a voice.state arrives for that peer; null otherwise
  muted: boolean;
  deafened: boolean;
}
```

**Voice store public API (consumed by story 005 — authoritative):**
```ts
export const voice: {
  // reactive state (getters)
  get status(): VoiceStatus;                 // idle | joining | connected | error
  get voiceChannelId(): number | null;       // the joined channel, null when not in voice
  get participants(): VoiceParticipant[];     // remote peers in the call (excludes self)
  get muted(): boolean;                       // local outbound mute
  get deafened(): boolean;                    // local inbound playback mute
  get error(): string | null;                 // mic-denied / transport-failed / voice.error

  // actions
  join(channelId: number): Promise<void>;     // capture mic + negotiate; sets error on failure
  leave(): void;                              // send voice.leave + full teardown
  toggleMute(): void;                         // pause/resume producer + relay voice.state
  toggleDeafen(): void;                       // mute/unmute inbound playback + relay voice.state
  teardown(): void;                           // socket-gone teardown (no voice.leave send)
};
```

**Gateway seam additions (`gateway.svelte.ts`):**
`sendVoice(op: string, d: unknown): boolean`, `onVoiceFrame(handler: (frame: ServerFrame) =>
void): void`, `onVoiceTeardown(handler: () => void): void`.

## Configuration / Environment Changes
One new runtime dependency: `mediasoup-client` added to `client/package.json` `dependencies`
(Step 1). No new env vars, config keys, or build-script changes. (mediasoup-client is a pure
browser/webview lib — no native build step in the client.)

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
|---|---|---|---|---|
| `gateway.svelte.ts` | `sendVoice(op, d)` | `op: string`, `d: unknown` | `boolean` (sent?) | Guards `readyState === OPEN`; mirrors `sendMessage`; the engine's only send path. |
| `gateway.svelte.ts` | `onVoiceFrame(handler)` | `(frame: ServerFrame) => void` | `void` | Registers the engine's inbound `voice.*` route; called once at module load. |
| `gateway.svelte.ts` | `onVoiceTeardown(handler)` | `() => void` | `void` | Fires on `disconnect()` + 4001 so a dropped socket tears voice down. |
| `voice.svelte.ts` | `voice.join(channelId)` | `number` | `Promise<void>` | Mic capture + full SFU negotiation; rejects-as-error (sets `error`), never throws into the void. |
| `voice.svelte.ts` | `voice.leave()` | — | `void` | `voice.leave` + teardown. |
| `voice.svelte.ts` | `voice.toggleMute()` | — | `void` | `producer.pause/resume` + `voice.state`. |
| `voice.svelte.ts` | `voice.toggleDeafen()` | — | `void` | local playback mute + `voice.state`. |
| `voice.svelte.ts` | `voice.teardown()` | — | `void` | socket-gone teardown (no `voice.leave`). |
| `voice.svelte.ts` | getters | — | see public API | `status`, `voiceChannelId`, `participants`, `muted`, `deafened`, `error`. |

## Edge Cases & Gotchas
- **Mic permission denied / no input device** — `getUserMedia` rejects in `join()`: set
  reactive `error`, reset status to `idle`, do **not** send `voice.join` (no half-join, presence
  stays out of voice). *(Step 4 `join`.)*
- **Transport connect/produce failure** — `voice.connect`/`voice.produce` have no reply, or the
  transport `connectionstatechange` goes `failed`/`disconnected`: surface as reactive
  `error`/status; `errb()` the corresponding transport event so mediasoup-client doesn't hang;
  `leave()` still cleans up. *(Step 4 transport-event wiring + `connectionstatechange`.)*
- **New producer mid-call** — `voice.new_producer` runs the same consume helper as
  `voice.joined.producers` (both directions wired, no silent one-way audio). *(Step 4
  `consumeProducer` via `handleVoiceFrame`.)*
- **Producer-closed / peer-left** — `voice.peer_left {participantId}` maps via
  `Map<participantId, producerId[]>` to close each consumer, stop + remove its `<audio>`, and
  drop the peer from the participant list + maps. *(Step 4 `handleVoiceFrame` `voice.peer_left`.)*
- **Mute toggle convergence** — `_muted` set to the final boolean before the `producer.pause/
  resume` + `voice.state` send, so rapid toggles converge. *(Step 4 `toggleMute`.)*
- **Leave/teardown on intentional disconnect AND 4001 auth-fail** — `gateway.disconnect()` and
  the 4001 `onclose` branch both invoke the registered `onVoiceTeardown` → `voice.teardown()`
  (which skips the `voice.leave` send since the socket is gone); App also calls `voice.leave()`/
  `voice.teardown()` for belt-and-suspenders. No dangling `MediaStream`s/transports. *(Steps 3
  & 5.)*
- **No second WS socket** — the engine never opens a `WebSocket`; all client→server ops go
  through `gateway.sendVoice` and all server→client frames arrive via `gateway.onVoiceFrame`
  (single `/ws` socket per the contract + feature constraint). *(Steps 3 & 4.)*
- **presence.update threading voiceChannelId** — the gateway's `presence.update` handler now
  copies `voiceChannelId` onto the member; the `ready` snapshot already carries it, so a missed
  update reconciles on reconnect. *(Step 3.)*
- **Idempotent re-join** — a `join()` while already `connected` is a no-op or leave-then-join,
  never producing two mic tracks (contract: idempotent re-join reuses `participantId`). *(Step 4
  `join` guard.)*
- **`voice.consume` with no reply** — caps-incompatible producers yield no `voice.consumer`;
  the engine doesn't block waiting (fire-and-handle on arrival, not await). *(Step 4
  `consumeProducer`.)*
- **Svelte 5 Map/array reactivity** — reassign `participants`/derived state after each mutation
  (the gateway's `_members = new Map(_members)` pattern). *(Step 4.)*

## Acceptance Criteria Checklist
- [ ] `mediasoup-client` added to `client/package.json`; reactive engine in a `*.svelte.ts` runes
      module with one teardown point → Steps 1, 4
- [ ] Join: `getUserMedia`, `Device.load(rtpCapabilities)`, create send+recv transports, wire
      `connect`/`produce` over WS, produce the Opus mic track → Step 4
- [ ] Consume every existing producer + each new producer; attach remote tracks to `<audio>`;
      handle producer-closed/peer-leave by closing the consumer + dropping audio → Steps 3, 4
- [ ] Mute toggle pauses the producer + sends `voice.state {muted}`; unmute resumes; optional
      deafen mutes inbound; rapid toggles converge → Step 4
- [ ] Leave/teardown: `voice.leave` + close producer/consumers/transports + stop mic tracks; WS
      disconnect/auth-fail also tears voice down cleanly; no dangling streams/transports →
      Steps 3, 4, 5
- [ ] Mic-permission denial + transport `failed`/`disconnected` surfaced as reactive error/conn
      state (not thrown into the void); leave still cleans up → Step 4
- [ ] `npm run typecheck` (incl. `svelte-check`) passes; two clients → audible two-way audio,
      working mute, clean leave → Steps 1–5 (manual verify)
- [ ] `contracts/voice-store.md` documents the reactive API (status, `voiceChannelId`,
      participants, `muted`/`deafened`, error, `join`/`leave`/`toggleMute`/`toggleDeafen`) →
      Step 6
