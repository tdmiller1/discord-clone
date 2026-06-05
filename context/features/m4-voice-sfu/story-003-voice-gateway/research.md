#research

# Research: WS gateway — voice.* signaling & voice presence

## Files to Touch

### Likely Modified
- `server/src/ws/gateway.ts` — add post-auth dispatch for the `voice.*` ops; thread the `VoiceSfu` and a new `VoiceRegistry` in via `WsGatewayOptions`; allocate a per-socket `participantId`; wire bidirectional consume; mute via `voice.state`; teardown closes SFU resources and clears voice presence; `buildReady` reports live `voiceChannelId` instead of the hardcoded `null`.
- `server/src/app.ts` — pass the already-constructed `sfu` (and a new `VoiceRegistry`) into `app.register(wsGateway, { config, hub, sfu })`. The `VoiceSfu` is already built (`const sfu = new VoiceSfu(config); await sfu.init();`) but is **not currently handed to the gateway** — that is the missing wire.
- `server/src/types.ts` — add the voice op payload interfaces (client→server and server→client) and extend the `ServerEvent` / `ClientCommand` discriminated unions. `Member` / `PresenceUpdatePayload` already carry `voiceChannelId` (no change to those two).

### Likely Created
- `server/src/ws/voice-registry.ts` — in-memory voice membership registry mirroring `PresenceRegistry`. Tracks each socket's `voiceChannelId` and reports join/leave transitions and per-user aggregation for multi-socket presence. (Could alternatively live inside `gateway.ts`, but a separate framework-agnostic class matches the `presence.ts` / `hub.ts` / `sfu.ts` house style.)
- `context/features/m4-voice-sfu/story-003-voice-gateway/contracts/voice-protocol.md` — the wire contract (every op, direction, `d` shape, the negotiation sequence, new/closed-producer notifications, `presence.update.voiceChannelId` semantics) that story 004 implements against. Required by the final acceptance criterion.

### Read-Only Reference (patterns to follow)
- `server/src/ws/presence.ts` — the `add`/`remove` → `{ firstOnline }`/`{ lastOffline }` transition pattern and `broadcast(env, except)`; the new `VoiceRegistry` mirrors it exactly.
- `server/src/ws/hub.ts` — `BroadcastHub` shape (private `Set`, bound arrow `broadcast`); the second reference for the registry house style.
- `server/src/voice/sfu.ts` — the `VoiceSfu` public surface the gateway relays (signatures + conventions reproduced in the story-002 contract).
- `server/src/ws/gateway.ts` — the existing `identify` / `message.send` dispatch, `teardown()`, heartbeat/reaper, and `buildReady`; the voice handlers slot into the same `socket.on("message")` switch and `teardown` closure.

## Existing Patterns

**Per-connection dispatch.** The gateway holds a `ConnState` per socket in `sockets: Map<WebSocket, ConnState>`. Inbound frames are parsed in `socket.on("message")`: JSON-parse guarded, `op` must be a string, pre-auth only `identify` is honored, post-auth there is currently a single `if (op !== "message.send") return;`. Voice ops are added as additional post-auth branches in this same block. Every payload field is validated defensively (`typeof ... !== "number"` / `!Number.isFinite` / `typeof ... !== "string"`) and any malformed frame is **silently dropped** (`return`) — never closes the socket. Voice frame validation must follow this exact tolerant style (story AC: "Unknown/invalid voice frames are ignored safely").

**Async handlers.** The current `socket.on("message")` callback is synchronous. The SFU methods (`createTransport`, `produce`, `consume`, …) are `async`/Promise-returning. The handler will need to `await` them; the implementer should make the relevant voice branch use an inner `async` IIFE or an `async` message handler and `.catch()` errors so a rejected SFU call never becomes an unhandled rejection or crashes the socket. Errors should be swallowed/logged and optionally surfaced as a `voice.error` frame to the requesting socket (decision below).

**Presence transition broadcast.** `registry.add(...)` returns `{ firstOnline }`; on `true` the gateway broadcasts `presence.update {status:"online", voiceChannelId:null}` to everyone *except* the joining socket. `registry.remove(...)` returns `{ lastOffline }`; on `true` (inside `teardown`) it broadcasts `{status:"offline", voiceChannelId:null}`. Voice presence mirrors this: joining voice broadcasts `presence.update` with the live `voiceChannelId` exactly on the transition; leaving broadcasts it back to `null` exactly on the last-socket-leaves transition.

**Teardown.** `teardown()` is a single idempotent closure (`toreDown` guard) wired to both `socket.on("close")` and `socket.on("error")`, and also reachable via the heartbeat reaper (`socket.terminate()`/`socket.close()` → close event). It clears the auth deadline, removes from `sockets`, `hub.remove(socket)`, and on last-offline broadcasts presence. Voice teardown is added **inside this same closure**, before/after the presence removal: if this socket was in voice, call `sfu.closeParticipant(channelId, participantId)`, remove from the `VoiceRegistry`, notify other participants to drop this peer's producer (`voice.peer_left` / closed-producer notification), and broadcast the voice `presence.update` on the per-user transition. This guarantees the same path covers leave, socket close, error, and heartbeat reap (story AC + feature edge case "Leave / disconnect / socket drop / heartbeat reap").

**Registry house style.** `PresenceRegistry` and `BroadcastHub` are plain classes, framework-agnostic (only import `WebSocket` type + `Envelope`), `#private` fields, methods returning transition booleans. The new `VoiceRegistry` follows this exactly.

**`buildReady`.** Currently maps users to `Member` with `voiceChannelId: null` hardcoded. It must instead query the `VoiceRegistry` for each user's live voice channel (any in-voice socket → that channelId; else null), mirroring how `status` already comes from `registry.isOnline(row.id)`.

## Data Flow

**Construction (boot).** `buildApp` already does `const sfu = new VoiceSfu(config); await sfu.init()`. Add `const voice = new VoiceRegistry()` and pass `{ config, hub, sfu, voice }` to `app.register(wsGateway, ...)`. The single seeded voice channel id is resolved via `getVoiceChannel(db)` (story 001) — used to validate join targets.

**Join → negotiate → produce → consume (client→server, all post-auth on an `identify`'d socket):**
1. `voice.join {channelId}` → gateway validates `channelId` equals `getVoiceChannel(db)?.id` (equivalently `getChannelById(db, id)?.type === "voice"`). A text/unknown channel → ignored/rejected, **no SFU calls**. On success: assign this socket a `participantId` (per-socket, e.g. a counter or random id — the SFU keys only on the string and a multi-socket user is intentionally multiple participants). Reply to the joiner with `getRtpCapabilities()` so its `Device` can load. Register the socket in `VoiceRegistry`; on the per-user join transition broadcast `presence.update {voiceChannelId}`.
2. Transport setup (one round trip per direction): client requests send + recv transports → gateway calls `sfu.createTransport(channelId, participantId, "send"|"recv")` and relays the `TransportParams`. Client calls `connectTransport` (DTLS) → gateway calls `sfu.connectTransport(..., dtlsParameters)`.
3. Produce (mic): client sends its `rtpParameters` → gateway calls `sfu.produce(channelId, participantId, rtpParameters)` → gets `{ producerId }`. The gateway then **announces this new producer** to every *other* participant in the room (server→client "new producer" notification) so existing peers issue a `consume` for it (feature edge case "New participant joins an ongoing call" — existing peers consume newcomer).
4. Consume existing producers: the newcomer must consume **all** existing producers — gateway calls `sfu.listProducers(channelId, newcomerParticipantId)` and, for each, `sfu.consume(channelId, participantId, producerId, clientRtpCapabilities)`. A `null` result (`!router.canConsume`) is skipped. Each non-null `ConsumeParams` is relayed to the newcomer. (Whether the newcomer's client drives the `consume` requests one-by-one, or the server pushes them, is the contract's call — see decision below.)
5. Resume handshake: each consumer is created `paused: true`. After the client confirms its receiving consumer is wired, it sends a resume request → gateway calls `sfu.resumeConsumer(channelId, participantId, producerId)`. Without this, no audio flows.

**Mute (`voice.state {muted, deafened}`):** `muted` true → `sfu.pauseProducer(channelId, participantId)`; false → `sfu.resumeProducer(...)`. Both are tolerant no-ops if no producer. The muted/deafened state is reflected to other participants (via `voice.state` relay and/or `presence.update`); `deafened` is local playback only (no server media change — out of scope per feature non-goals, but the flag may be relayed). Rapid toggles converge because pause/resume are idempotent.

**Leave / teardown:** `voice.leave` or socket close/error/reap → inside `teardown()`: `sfu.closeParticipant(channelId, participantId)` (closes transports → cascades to producer + consumers; returns `{ roomEmpty }`); remove socket from `VoiceRegistry`; notify other participants to **drop this peer's consumer** (server→client closed-producer / peer-left notification carrying the departed `producerId` or `participantId`); on the per-user voice last-leave transition, broadcast `presence.update {voiceChannelId:null}`. `roomEmpty` signals the room was released (stop broadcasting voice state for the empty channel).

**Reconnect / ready snapshot:** `buildReady` reports each user's live `voiceChannelId` from the `VoiceRegistry`, so a client that missed a `presence.update` while offline reconciles voice membership from `ready.members[].voiceChannelId` (feature edge case "Reconnect race").

## Decisions Made

1. **Op shape: structured request/response set, not raw `voice.signal` SDP relay.** SPEC §7 lists a generic `voice.signal {from, sdp/ice}`, but that envelope models a mesh/raw-SDP relay. The SFU core (story 002) exposes a *structured* mediasoup API (createTransport → connectTransport → produce → consume → resumeConsumer), which is what `mediasoup-client` (story 004) expects — it never exchanges raw SDP. The story explicitly permits "a small request/response set — document whichever shape is used in the contract." I chose a request/response op set (e.g. `voice.join`, `voice.transport` request → response, `voice.connect`, `voice.produce`, `voice.consume`, `voice.resume`, `voice.state`, `voice.leave`, plus server→client `voice.new_producer` / `voice.peer_left` / `voice.error`). The contract will pin exact names and `d` shapes; the SFU's returned `TransportParams` / `RtpCapabilities` / `ConsumeParams` are relayed verbatim.

2. **`participantId` = per-socket id minted by the gateway.** The story-002 contract states the gateway chooses `participantId` per socket (a user on two sockets is two participants). I will mint a unique string per voice-joined socket (counter or `crypto.randomUUID()`), stored on `ConnState`. This keeps multi-socket users as independent SFU participants and makes teardown of one socket not affect the other (feature edge case "Multi-socket user").

3. **`VoiceRegistry` as a separate module, not inline state.** Mirrors `presence.ts`/`hub.ts` rather than scattering maps inside the route closure; gives the per-user aggregation (`voiceChannelOf(userId)`) `buildReady` needs and the transition booleans the broadcast logic needs. Keyed by socket with a reverse `userId → voiceChannelId` view for multi-socket presence (any socket in voice ⇒ user is in voice).

4. **Voice presence transitions are per-user, mirroring online/offline.** `presence.update {voiceChannelId}` fires on the *first* socket of a user entering voice and `{voiceChannelId:null}` on the *last* leaving — exactly the `firstOnline`/`lastOffline` analogue — so a multi-socket user shows in voice if *any* socket is in voice (feature edge case "Multi-socket user").

5. **Errors are swallowed/logged and optionally surfaced as `voice.error` to the requester, never crash the socket.** Consistent with the existing tolerant dispatch (malformed frames `return`), but SFU `connectTransport`/`produce`/`consume`/`resumeConsumer` *throw* on unknown channel/participant (story-002 contract). The voice branch wraps awaited SFU calls in try/catch; a failure is logged and answered with a `voice.error` frame to that socket rather than propagating. Exact `voice.error` shape pinned in the contract.

6. **Double/re-join is idempotent via the SFU's own idempotency.** `createTransport`/`produce` already replace prior transport/producer, so a `voice.join` while already in voice does not create a second mic track. The gateway will reuse the existing `participantId` for the same socket (or leave-then-join) rather than minting a second one (feature edge case "Double join / re-join").
