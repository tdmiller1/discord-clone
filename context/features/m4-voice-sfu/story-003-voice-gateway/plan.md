#plan

# Plan: WS gateway — voice.* signaling & voice presence

## Summary
Wire the already-constructed `VoiceSfu` into the WS gateway and add a `VoiceRegistry`
(mirroring `PresenceRegistry`) so authed sockets can run a structured `voice.*`
request/response signaling set (join → negotiate transports → produce → consume →
resume → state → leave) over the existing `{op,d}` envelope, with bidirectional consume
fan-out, mute, live `voiceChannelId` presence, and full teardown on leave/close/error/reap.

## Decisions carried from research (all "Decisions Made" treated as final)
- Structured request/response op set (not raw `voice.signal` SDP relay) — names pinned in
  the contract below. The SFU returns mediasoup `TransportParams`/`RtpCapabilities`/`ConsumeParams`
  relayed verbatim.
- `participantId` = a per-socket string minted by the gateway (`crypto.randomUUID()`),
  stored on `ConnState`. A user on two sockets is two participants.
- `VoiceRegistry` is a separate framework-agnostic module mirroring `presence.ts`.
- Voice presence transitions are per-user (first-socket-in / last-socket-out), mirroring
  online/offline.
- SFU calls are wrapped in try/catch; failures are logged and answered with a
  `voice.error` frame to the requesting socket — never crash the socket.
- Re-join reuses the same per-socket `participantId`; the SFU's own idempotency
  (`createTransport`/`produce` replace prior) prevents a second mic track.

Additional resolution made in this plan (not explicit in the story): **the newcomer drives
its own `consume` requests** rather than the server pushing them. On `voice.join` the server
returns the existing producer list (`voice.producers`) so the client issues one `voice.consume`
per producer; existing peers receive a `voice.new_producer` push and likewise issue a
`voice.consume`. This keeps every `consume` paired with the client's own resume handshake and
avoids the server guessing client readiness (matches the SFU's paused-consumer convention).

## Implementation Steps

### Step 1: Add voice op payload types to `types.ts`
**File(s):** `server/src/types.ts`
**Action:** modify
**Description:** Add the client→server and server→client voice payload interfaces and extend
the `ClientCommand` / `ServerEvent` discriminated unions. mediasoup param shapes are typed as
the verbatim shapes the SFU returns; inbound mediasoup params (dtls/rtp parameters) are typed
loosely as `unknown` at the union level (the handler validates only that they are objects and
forwards them to the SFU, which owns their real types) to avoid importing `mediasoup` types into
the shared `types.ts`.
**Diff shape:**
- Add: `VoiceJoinPayload`, `VoiceLeavePayload` (no fields / empty `d`), `VoiceTransportRequestPayload`,
  `VoiceConnectPayload`, `VoiceProducePayload`, `VoiceConsumePayload`, `VoiceResumePayload`,
  `VoiceStatePayload` (client→server).
- Add: `VoiceJoinedPayload`, `VoiceTransportPayload`, `VoiceProducedPayload`, `VoiceProducersPayload`,
  `VoiceConsumePayloadServer` (named `VoiceConsumerPayload`), `VoiceNewProducerPayload`,
  `VoicePeerLeftPayload`, `VoiceStateUpdatePayload`, `VoiceErrorPayload` (server→client).
- Change: extend `ClientCommand` union with the 8 client voice ops; extend `ServerEvent` union
  with the 9 server voice ops. Update the `Member.voiceChannelId` comment ("always null in M1"
  → "live voice channel from VoiceRegistry").

### Step 2: Create the `VoiceRegistry`
**File(s):** `server/src/ws/voice-registry.ts`
**Action:** create
**Description:** A plain `#private`-field class mirroring `PresenceRegistry`, keyed
`Map<userId, Map<socket, channelId>>` so it tracks per-socket voice channel and reports
per-user join/leave transitions plus the aggregation `buildReady` needs.
**Diff shape:**
- Add: `add(userId, socket, channelId): { firstInVoice: boolean }` — true when this is the
  user's first in-voice socket.
- Add: `remove(userId, socket): { lastInVoice: boolean; channelId: number | null }` — true when
  the user's last in-voice socket left; returns the channel it was in (idempotent for unknown).
- Add: `voiceChannelOf(userId): number | null` — the channel the user is in if any socket is in
  voice, else null (used by `buildReady`).
- Add: no `broadcast` (the gateway reuses `registry.broadcast`/`hub` for presence fan-out;
  voice-room-scoped pushes are done by iterating `sockets`). Keep it import-light (only the
  `WebSocket` type).

### Step 3: Thread `sfu` + `voice` into the gateway options and `app.ts`
**File(s):** `server/src/app.ts`, `server/src/ws/gateway.ts`
**Action:** modify
**Description:** Pass the already-constructed `sfu` and a new `VoiceRegistry` into the gateway
plugin. The `sfu` exists in `buildApp` but is never handed to the gateway today — this is the
missing wire.
**Diff shape:**
- Change (`app.ts`): construct `const voice = new VoiceRegistry();` and register
  `app.register(wsGateway, { config, hub, sfu, voice })`. Import `VoiceRegistry`.
- Change (`gateway.ts`): extend `WsGatewayOptions` with `sfu: VoiceSfu` and `voice: VoiceRegistry`;
  destructure them; import both types/classes. Resolve the single voice room once per join via
  `getVoiceChannel(db)` (import added).

### Step 4: Add `participantId` + voice tracking to `ConnState`
**File(s):** `server/src/ws/gateway.ts`
**Action:** modify
**Description:** Give each socket the per-socket voice identifiers needed for SFU calls and
teardown.
**Diff shape:**
- Add to `ConnState`: `participantId: string | null` (minted on first `voice.join`),
  `voiceChannelId: number | null` (the room this socket is in, or null).
- Change: initialize both to `null` in the per-socket `state` object.

### Step 5: Map each socket back to its `userId` for room-scoped pushes / new-producer fan-out
**File(s):** `server/src/ws/gateway.ts`
**Action:** modify
**Description:** `voice.new_producer` and `voice.peer_left` must reach only the *other* sockets
currently in the same voice room. Add a small helper that iterates `sockets` and sends an
envelope to every socket whose `state.voiceChannelId === channelId`, optionally excluding one
socket. (No new map needed — `sockets: Map<WebSocket, ConnState>` already carries each socket's
`voiceChannelId` after Step 4.)
**Diff shape:**
- Add: `const broadcastToRoom = (channelId, env, except?) => { for (const [s, st] of sockets) { if (s === except) continue; if (st.voiceChannelId === channelId && s.readyState === s.OPEN) s.send(JSON.stringify(env)); } }`.

### Step 6: Add the post-auth voice dispatch branch
**File(s):** `server/src/ws/gateway.ts`
**Action:** modify
**Description:** Replace the single `if (op !== "message.send") return;` gate with a dispatch
that also routes `voice.*` ops. Because SFU methods are async, route voice ops into an inner
`async` handler that `await`s the SFU and `.catch()`es so a rejected call never becomes an
unhandled rejection. Each branch validates its `d` defensively (tolerant: malformed → `return`,
never close) exactly like `message.send`. On any caught SFU error, send a `voice.error` frame to
that socket.
**Diff shape:**
- Change: after the `message.send` handling, add `if (op.startsWith("voice.")) { void handleVoice(socket, state, op, d).catch((err) => { app.log.error(err); send(socket, { op: "voice.error", d: { op, message: "voice operation failed" } }); }); return; }` (or equivalent), then keep the final implicit ignore for unknown ops.
- Add: a `handleVoice(socket, state, op, d)` async function (defined in the connection scope or as
  a closure with access to `sfu`, `voice`, `db`, `sockets`, `broadcastToRoom`, `registry`, `hub`).

### Step 7: Implement `voice.join`
**File(s):** `server/src/ws/gateway.ts` (inside `handleVoice`)
**Action:** modify
**Description:** Validate target, mint participant id, register voice presence, return router caps
+ the existing producer list. **No transports/producer are created yet** — those come from the
client's subsequent `voice.transport`/`voice.produce` ops (lazy, matching the SFU's
create-on-first-`createTransport` room model).
**Diff shape:**
- Add: read `d.channelId` (number, finite); resolve `const vc = getVoiceChannel(db)`; reject if
  `!vc || vc.id !== channelId` → send `voice.error` and `return` (no SFU calls). Idempotent
  re-join: if `state.voiceChannelId === channelId` already, reuse existing `participantId`
  (re-send `voice.joined`); else mint `state.participantId ??= crypto.randomUUID()`.
- Add: set `state.voiceChannelId = channelId`; `const { firstInVoice } = voice.add(state.userId!, socket, channelId)`.
- Add: send `voice.joined` to the joiner `{ channelId, participantId, rtpCapabilities: sfu.getRtpCapabilities(), producers: sfu.listProducers(channelId, state.participantId) }`. (Combines the join ack with the existing-producer list so the newcomer can consume all existing producers — feature edge "new participant joins ongoing call", newcomer side.)
- Add: on `firstInVoice`, broadcast `presence.update {userId, status:"online", voiceChannelId: channelId}` to everyone except the joining socket via `registry.broadcast(env, socket)`.

### Step 8: Implement `voice.transport` (create) and `voice.connect`
**File(s):** `server/src/ws/gateway.ts` (inside `handleVoice`)
**Action:** modify
**Description:** Relay transport creation and DTLS connect to the SFU.
**Diff shape:**
- Add (`voice.transport`): validate `state.voiceChannelId !== null` and `state.participantId !== null`
  (else `voice.error`); validate `d.direction` is `"send"|"recv"`; `const params = await sfu.createTransport(state.voiceChannelId, state.participantId, direction)`; send `voice.transport {direction, ...params}` to the socket.
- Add (`voice.connect`): validate direction + `d.dtlsParameters` is a non-null object; `await sfu.connectTransport(state.voiceChannelId, state.participantId, direction, dtlsParameters)`; optionally send a `voice.connected {direction}` ack.

### Step 9: Implement `voice.produce` (mic) + new-producer announce
**File(s):** `server/src/ws/gateway.ts` (inside `handleVoice`)
**Action:** modify
**Description:** Produce the participant's mic track and announce the new producer to other peers
in the room so they each consume it (feature edge "new participant joins ongoing call", existing
peers side).
**Diff shape:**
- Add: validate in-voice + `d.rtpParameters` is a non-null object; `const { producerId } = await sfu.produce(state.voiceChannelId, state.participantId, rtpParameters)`.
- Add: send `voice.produced {producerId}` ack to the producer's socket.
- Add: `broadcastToRoom(state.voiceChannelId, { op:"voice.new_producer", d:{ participantId: state.participantId, producerId } }, socket)` — announce to every *other* in-room socket so they issue a `voice.consume`.

### Step 10: Implement `voice.consume` + `voice.resume`
**File(s):** `server/src/ws/gateway.ts` (inside `handleVoice`)
**Action:** modify
**Description:** Relay consume (paused) and the post-handshake resume. Handle the SFU's `null`
return (incompatible caps) by skipping silently.
**Diff shape:**
- Add (`voice.consume`): validate in-voice; `d.producerId` string; `d.rtpCapabilities` non-null object; `const params = await sfu.consume(state.voiceChannelId, state.participantId, producerId, rtpCapabilities)`; if `params === null` return (skip, no frame); else send `voice.consumer {...params}` to the socket.
- Add (`voice.resume`): validate in-voice; `d.producerId` string; `await sfu.resumeConsumer(state.voiceChannelId, state.participantId, producerId)`; optionally send `voice.resumed {producerId}` ack.

### Step 11: Implement `voice.state` (mute/deafen)
**File(s):** `server/src/ws/gateway.ts` (inside `handleVoice`)
**Action:** modify
**Description:** Pause/resume the producer on mute and relay the muted/deafened flags to other
room peers. `deafened` is local playback only — relayed but no server media change.
**Diff shape:**
- Add: validate in-voice; read `d.muted` (boolean), `d.deafened` (boolean, optional/default false);
  `if (muted) sfu.pauseProducer(...) else sfu.resumeProducer(...)` (both tolerant no-ops if no
  producer — idempotent under rapid toggles).
- Add: `broadcastToRoom(state.voiceChannelId, { op:"voice.state", d:{ userId: state.userId, participantId: state.participantId, muted, deafened } }, socket)` so peers reflect mute/deafen state.

### Step 12: Implement `voice.leave` + extract a `leaveVoice` helper used by teardown
**File(s):** `server/src/ws/gateway.ts`
**Action:** modify
**Description:** Centralize voice exit so `voice.leave` and `teardown()` share one path (covers
leave, socket close, error, heartbeat reap — feature edge "leave/disconnect/socket drop/reap").
**Diff shape:**
- Add: `const leaveVoice = (socket, state) => { if (state.voiceChannelId === null || state.participantId === null) return; const channelId = state.voiceChannelId; const participantId = state.participantId; sfu.closeParticipant(channelId, participantId); broadcastToRoom(channelId, { op:"voice.peer_left", d:{ participantId } }, socket); const { lastInVoice } = voice.remove(state.userId!, socket); state.voiceChannelId = null; if (lastInVoice) registry.broadcast({ op:"presence.update", d:{ userId: state.userId, status: "online", voiceChannelId: null } }, socket); }`. (Note: `voice.peer_left` is computed/broadcast *before* clearing `state.voiceChannelId` so `broadcastToRoom`'s room filter still matches the leaver's peers; the leaver itself is excluded via `except`.)
- Add (`voice.leave` branch in `handleVoice`): call `leaveVoice(socket, state)`.
- Note: `participantId` is intentionally **not** reset on leave so a leave-then-rejoin on the same
  socket reuses it (decision 6).

### Step 13: Call `leaveVoice` inside `teardown()`
**File(s):** `server/src/ws/gateway.ts`
**Action:** modify
**Description:** Ensure socket close/error/reap releases SFU resources and clears voice presence.
**Diff shape:**
- Change: inside the existing `teardown()` closure, before `registry.remove(...)` (the
  online/offline presence step), call `leaveVoice(socket, state)`. Because `leaveVoice` broadcasts
  to room peers using `state.voiceChannelId` it must run before that field is otherwise touched;
  it is idempotent (guards on null) so a socket never in voice is a no-op.

### Step 14: Make `buildReady` report live `voiceChannelId`
**File(s):** `server/src/ws/gateway.ts`
**Action:** modify
**Description:** Replace the hardcoded `voiceChannelId: null` with the registry lookup, mirroring
how `status` comes from `registry.isOnline`.
**Diff shape:**
- Change: in the `members` map, `voiceChannelId: voice.voiceChannelOf(row.id)`.

### Step 15: Write the wire contract
**File(s):** `context/features/m4-voice-sfu/story-003-voice-gateway/contracts/voice-protocol.md`
**Action:** create
**Description:** Document every voice op (name, direction, `d` shape), the
join→negotiate→produce→consume→resume sequence, the `voice.new_producer` /
`voice.peer_left` notifications, the `voice.error` shape, and the
`presence.update.voiceChannelId` semantics — the authoritative wire contract story 004
implements against. Content mirrors the "New Types / Schemas / Contracts" section below.

## New Types / Schemas / Contracts

Every voice WS op (story 004 implements against this). mediasoup param objects
(`iceParameters`, `iceCandidates`, `dtlsParameters`, `rtpParameters`, `rtpCapabilities`) are
passed through verbatim; their concrete types are mediasoup's (`types.*`) and are typed loosely
(`unknown`/`object`) at the gateway boundary.

```ts
// ---------- client → server ----------

/** voice.join — request to join the seeded voice channel. */
interface VoiceJoinPayload { channelId: number; }

/** voice.transport — request a send|recv WebRtcTransport. */
interface VoiceTransportRequestPayload { direction: "send" | "recv"; }

/** voice.connect — complete DTLS for a transport. */
interface VoiceConnectPayload { direction: "send" | "recv"; dtlsParameters: unknown; }

/** voice.produce — publish the mic track. */
interface VoiceProducePayload { rtpParameters: unknown; }

/** voice.consume — consume a remote producer (server replies paused). */
interface VoiceConsumePayload { producerId: string; rtpCapabilities: unknown; }

/** voice.resume — resume a previously-consumed producer post-handshake. */
interface VoiceResumePayload { producerId: string; }

/** voice.state — mute/deafen toggle. deafened is local playback only. */
interface VoiceStatePayload { muted: boolean; deafened?: boolean; }

/** voice.leave — leave the voice channel (no fields). */
interface VoiceLeavePayload {}

// ---------- server → client ----------

/** voice.joined — ack of voice.join: router caps + existing producers to consume. */
interface VoiceJoinedPayload {
  channelId: number;
  participantId: string;
  rtpCapabilities: unknown;                                  // router RTP capabilities (Device.load)
  producers: { participantId: string; producerId: string }[]; // existing producers (consume all)
}

/** voice.transport — created transport params (Device.createSend/RecvTransport). */
interface VoiceTransportPayload {
  direction: "send" | "recv";
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown;
  dtlsParameters: unknown;
}

/** voice.connected — optional ack of voice.connect. */
interface VoiceConnectedPayload { direction: "send" | "recv"; }

/** voice.produced — ack of voice.produce: this socket's producer id. */
interface VoiceProducedPayload { producerId: string; }

/** voice.consumer — consume params (transport.consume input); created paused. */
interface VoiceConsumerPayload {
  id: string;
  producerId: string;
  kind: "audio";
  rtpParameters: unknown;
}

/** voice.resumed — optional ack of voice.resume. */
interface VoiceResumedPayload { producerId: string; }

/** voice.new_producer — a peer started producing; consume it. */
interface VoiceNewProducerPayload { participantId: string; producerId: string; }

/** voice.peer_left — a peer left/disconnected; drop its consumer/<audio>. */
interface VoicePeerLeftPayload { participantId: string; }

/** voice.state — a peer's mute/deafen changed (relay). */
interface VoiceStateUpdatePayload {
  userId: number;
  participantId: string;
  muted: boolean;
  deafened: boolean;
}

/** voice.error — a voice op failed for the requesting socket (never closes the socket). */
interface VoiceErrorPayload { op: string; message: string; }
```

`presence.update.voiceChannelId` semantics: the existing `PresenceUpdatePayload` is reused
unchanged. It is broadcast with `voiceChannelId = <channel>` on a user's first-in-voice
transition and with `voiceChannelId = null` on the last-in-voice transition (per-user, mirroring
online/offline). `status` stays `"online"` across both (the user is still connected). `ready`'s
`members[].voiceChannelId` reflects the live registry value so a reconnecting client reconciles.

`ClientCommand` gains: `voice.join`, `voice.transport`, `voice.connect`, `voice.produce`,
`voice.consume`, `voice.resume`, `voice.state`, `voice.leave`.
`ServerEvent` gains: `voice.joined`, `voice.transport`, `voice.connected`, `voice.produced`,
`voice.consumer`, `voice.resumed`, `voice.new_producer`, `voice.peer_left`, `voice.state`,
`voice.error`.

## Configuration / Environment Changes
None. (The SFU already reads `rtcMinPort`/`rtcMaxPort`/`publicHost` via `loadConfig`; voice
membership is in-memory and persists nothing — no new env vars, config keys, or DB columns.)

## API / Interface Changes

| Surface | Identifier | Request / Input (`d`) | Response / Output (`d`) | Notes |
| ------- | ---------- | --------------------- | ----------------------- | ----- |
| WS op c→s | `voice.join` | `{channelId}` | `voice.joined {channelId, participantId, rtpCapabilities, producers[]}` | Validates seeded voice channel; mints participantId; sets voice presence |
| WS op c→s | `voice.transport` | `{direction}` | `voice.transport {direction, id, iceParameters, iceCandidates, dtlsParameters}` | `sfu.createTransport` |
| WS op c→s | `voice.connect` | `{direction, dtlsParameters}` | `voice.connected {direction}` | `sfu.connectTransport` (DTLS) |
| WS op c→s | `voice.produce` | `{rtpParameters}` | `voice.produced {producerId}` + `voice.new_producer` to peers | `sfu.produce` |
| WS op c→s | `voice.consume` | `{producerId, rtpCapabilities}` | `voice.consumer {...}` or nothing if incompatible | `sfu.consume`; paused |
| WS op c→s | `voice.resume` | `{producerId}` | `voice.resumed {producerId}` | `sfu.resumeConsumer` |
| WS op c→s | `voice.state` | `{muted, deafened?}` | `voice.state {userId, participantId, muted, deafened}` to peers | pause/resume producer |
| WS op c→s | `voice.leave` | `{}` | `voice.peer_left {participantId}` to peers; `presence.update` on last-leave | `sfu.closeParticipant` |
| WS op s→c | `voice.new_producer` | — | `{participantId, producerId}` | Peer started producing → consume it |
| WS op s→c | `voice.peer_left` | — | `{participantId}` | Peer left → drop consumer/audio |
| WS op s→c | `voice.error` | — | `{op, message}` | A voice op failed; socket stays open |
| Gateway opts | `WsGatewayOptions` | — | adds `sfu: VoiceSfu`, `voice: VoiceRegistry` | Wired from `buildApp` |

## Edge Cases & Gotchas

- **Mic-less / mic-denied join (no producer):** the client may `voice.join` and consume without
  ever `voice.produce`-ing; `listProducers` and mute paths tolerate no producer → handled by
  Steps 7/11 (join doesn't require a producer; `pauseProducer` is a no-op).
- **Join a non-voice / unknown channel:** Step 7 rejects via `getVoiceChannel(db)` id check,
  sends `voice.error`, allocates **no** SFU resources.
- **New participant joins ongoing call (both directions):** newcomer consumes all existing
  producers from `voice.joined.producers` (Step 7); existing peers get `voice.new_producer` from
  the newcomer's `voice.produce` (Step 9). No one-way audio.
- **Leave / disconnect / socket drop / heartbeat reap:** single `leaveVoice` helper (Step 12)
  invoked by both `voice.leave` and `teardown()` (Step 13) — closes SFU resources, notifies peers
  (`voice.peer_left`), clears voice presence on last-leave.
- **Double join / re-join (no second mic track):** Step 7 reuses the existing `participantId` if
  the socket is already in the channel; the SFU's `createTransport`/`produce` replace prior
  resources (decision 6).
- **Mute toggle (rapid):** `pauseProducer`/`resumeProducer` are idempotent no-ops; rapid toggles
  converge → Step 11.
- **Multi-socket user:** per-socket `participantId` makes each socket an independent participant;
  `VoiceRegistry` aggregates per-user (`firstInVoice`/`lastInVoice`) so presence shows in-voice if
  *any* socket is in voice, and teardown of one socket doesn't affect the other → Steps 2, 7, 12.
- **Async SFU calls in a sync message handler:** voice ops are dispatched into an `async`
  `handleVoice` with a top-level `.catch()` that emits `voice.error`, so a rejected SFU call never
  becomes an unhandled rejection or crashes the socket → Step 6.
- **SFU throws on unknown channel/participant:** ops sent before `voice.join` (no
  `state.voiceChannelId`/`participantId`) are rejected with `voice.error` *before* calling the SFU
  (guards in Steps 8–11), and any SFU throw is still caught by Step 6.
- **Malformed/unknown voice frame:** each branch validates `d` defensively and `return`s on bad
  input (never closes); unknown `voice.*` op falls through `handleVoice`'s switch to a no-op →
  Steps 6–11. (AC: "Unknown/invalid voice frames are ignored safely.")
- **Room-scoped push correctness on leave:** `voice.peer_left` is broadcast using the leaver's
  `channelId` *before* `state.voiceChannelId` is cleared, so the room filter matches → Step 12.

## Acceptance Criteria Checklist

- [ ] Gateway handles client→server voice ops on authed sockets via `{op,d}`; unknown/invalid
  frames ignored safely, nothing crashes → Steps 4, 6, 7–12
- [ ] `voice.join` validates the seeded voice channel; text/unknown rejected with no SFU
  resources; returns router caps + transport negotiation path → Step 7 (+ Steps 8–10 for the
  negotiation ops)
- [ ] Bidirectional consume wiring (newcomer consumes all existing; peers consume the new
  producer) → Steps 7 (`producers` list) + 9 (`voice.new_producer`)
- [ ] `voice.state {muted}` pauses/resumes the producer; state reflected to others → Step 11
- [ ] Voice presence registry tracks per-socket `voiceChannelId`; join/leave broadcast
  `presence.update` on the transition; `buildReady` reports live `voiceChannelId` → Steps 2, 7,
  12, 14
- [ ] Teardown closes SFU resources, removes from room, clears `voiceChannelId`, broadcasts
  `presence.update`, tells peers to drop the consumer; multi-socket safe → Steps 12, 13
- [ ] `npm run typecheck` passes; `voice.join` returns valid negotiation params and presence shows
  in voice → all steps (verified by typecheck + manual `websocat`)
- [ ] `contracts/voice-protocol.md` specifies every op, the negotiation sequence, the
  new/closed-producer notifications, and `presence.update.voiceChannelId` semantics → Step 15
