#research

# Research: Client — mediasoup-client voice engine (publish/consume/mute)

## Files to Touch

### Likely Modified
- `client/package.json` — add `mediasoup-client` to `dependencies` (currently only `@tauri-apps/api`). This is the one new runtime dep this story needs.
- `client/src/lib/gateway.svelte.ts` — the voice engine must ride the **same** `/ws` socket. The gateway today owns `socket` as a module-local and only `handleFrame`s `ready`/`presence.update`/`channel.create`/`message.create`, and exposes only `sendMessage`. Two additions are needed: (1) a way for the voice engine to **send** `voice.*` ops over the live socket (e.g. a `sendVoice(op, d)` method that guards `readyState === OPEN`, mirroring `sendMessage`), and (2) a way for the voice engine to **receive** `voice.*` frames — either a frame-listener registration the engine subscribes to, or routing `voice.*` ops in `handleFrame` into the voice module. Also: the `presence.update` handler currently **drops** `voiceChannelId` (it only copies `status`) and the `ready` handler stores members verbatim; voice presence reconciliation will want `voiceChannelId` carried through (see Decisions). Teardown (`disconnect()`) and the 4001 path must also trigger voice teardown.
- `client/src/lib/types.ts` — extend the `ServerFrame` discriminated union with the server→client `voice.*` envelopes (`voice.joined`, `voice.transport`, `voice.connected`, `voice.produced`, `voice.consumer`, `voice.resumed`, `voice.new_producer`, `voice.peer_left`, `voice.state`, `voice.error`) and add their payload interfaces (mirror the contract verbatim; mediasoup params typed `unknown`). Also extend `PresenceUpdatePayload` handling — the type already has `voiceChannelId` but it's documented "always null in M1"; update the comment and ensure it's threaded through. Add the client→server `voice.*` payload types if the engine builds typed frames.

### Likely Created
- `client/src/lib/voice.svelte.ts` (or `voiceStore.svelte.ts`) — the reactive voice engine. A `*.svelte.ts` runes module mirroring `gateway.svelte.ts`: `$state` for voice status / `voiceChannelId` / participants / `muted` / `deafened` / error, module-local **non-reactive** mediasoup `Device`, send/recv `Transport`s, the local `Producer`, a `Map<producerId, Consumer>`, the local mic `MediaStream`, and a `Map<participantId, producerId[]>` (to map `voice.peer_left` → consumers). Exposes `join()`/`leave()`/`toggleMute()`/`toggleDeafen()` actions plus a single teardown point. This is the `contracts/voice-store.md` deliverable (story 004 `provides_contract`).
- `context/features/m4-voice-sfu/story-004-client-voice-engine/contracts/voice-store.md` — documents the reactive API story 005's UI consumes (status, `voiceChannelId`, participant list, `muted`/`deafened`, error, and the actions). Required by the last acceptance criterion and the story frontmatter.

### Read-Only Reference (patterns to follow)
- `client/src/lib/gateway.svelte.ts` — the canonical shape to mirror: module-level `$state` + `$derived`, **non-reactive** module-local socket/timers, a single exported singleton object with `get` accessors and action methods, one `disconnect()`/teardown point, `socket.send(JSON.stringify({ op, d }))` framing, and the `socket.readyState !== WebSocket.OPEN` guard before sending.
- `client/src/lib/authStore.svelte.ts` — the minimal runes-module-as-singleton pattern (`$state` privates, getter-only public object, explicit mutators, a `clear()` teardown).
- `client/src/lib/channelStore.svelte.ts` — tiny example of a separate runes store consumed by other modules without pulling in WS internals (the gateway/voice split should mirror this — UI imports voice actions without WS guts).
- `client/src/App.svelte` — where `gateway.disconnect()` / `gateway.clearAuthFailed()` are called on logout (line 47) and 4001 (line 59); voice teardown must hang off the same lifecycle (either inside `gateway.disconnect()` or alongside it in App).
- `client/src/lib/Presence.svelte` (lines 69–74) — `onMount(() => gateway.connect())` / `onDestroy(() => gateway.disconnect())` and the `authFailed → onSessionInvalid()` reaction; the canonical "where the socket lifecycle is driven" spot.

## Existing Patterns

**Runes-module singleton.** Every store is a `*.svelte.ts` file with module-level `let _x = $state(...)`, optional `$derived`, and a single exported `const foo = { get x() {...}, action() {...} }`. Reactive state lives in `$state`; sockets/timers/SDK objects are plain module locals (the gateway's `socket`, `reconnectTimer`, `backoffMs` are deliberately **not** `$state`). The voice engine should follow this exactly: `Device`/`Transport`/`Producer`/`Consumer`/`MediaStream` are non-reactive module locals; only UI-facing facts (status, participant list, muted, error) are `$state`.

**Frame send.** `socket.send(JSON.stringify({ op, d }))` after guarding `socket !== null && socket.readyState === WebSocket.OPEN` (see `sendMessage`). The identify frame is sent in `ws.onopen`. There is **no** generic send export today — the voice engine needs one added to the gateway.

**Frame dispatch.** `ws.onmessage` JSON-parses, validates via `isServerFrame` (object with string `op`), then `handleFrame` switches on `frame.op`; unknown ops hit `default: break` (silently ignored). Maps are reassigned (`_members = new Map(_members)`) after mutation because Svelte 5 Maps aren't deeply reactive — the voice store must do the same for its participant/consumer-derived reactive state.

**Lifecycle/teardown.** One `connect()` (resets backoff, opens) and one `disconnect()` (sets `intentional`, clears timers, wipes reactive state, closes socket 1000). The 4001 close sets a one-shot `authFailed` flag App reacts to. Voice teardown must be wired into both the intentional `disconnect()` and the 4001 path so a dropped/auth-failed socket releases mic + transports.

## Data Flow

**Join** (`voice.join` → audible two-way):
1. UI calls `voice.join(channelId)`. Engine sets status `joining`, runs `getUserMedia({ audio: true })` for the mic track (catch rejection → reactive error, do **not** commit join — per edge case).
2. Engine sends `voice.join {channelId}` over the gateway socket.
3. Server replies `voice.joined {channelId, participantId, rtpCapabilities, producers[]}`. Engine stores `participantId`, sets reactive `voiceChannelId`, and `await device.load({ routerRtpCapabilities: rtpCapabilities })`.
4. Engine requests transports: send `voice.transport {direction:"send"}` and `{direction:"recv"}`. On each `voice.transport {direction,id,iceParameters,iceCandidates,dtlsParameters}` reply, call `device.createSendTransport(...)` / `device.createRecvTransport(...)`.
5. Wire transport events. On the **send** transport `"connect"` event `({dtlsParameters}, cb, errb)`: send `voice.connect {direction:"send", dtlsParameters}`; resolve the event's `cb()` when `voice.connected {direction:"send"}` arrives. Same for recv. On the send transport `"produce"` event `({kind, rtpParameters}, cb, errb)`: send `voice.produce {rtpParameters}`; on `voice.produced {producerId}` call `cb({ id: producerId })`. Listen to transport `connectionstatechange` for `failed`/`disconnected` → reactive error/connection state (edge case).
6. **Produce:** `sendTransport.produce({ track: micTrack })` → triggers the `"produce"` event above → stores the local `Producer`.
7. **Consume existing:** for each `{participantId, producerId}` in `voice.joined.producers`, send `voice.consume {producerId, rtpCapabilities: device.rtpCapabilities}`. On `voice.consumer {id, producerId, kind, rtpParameters}` call `recvTransport.consume({ id, producerId, kind, rtpParameters })`, store the `Consumer` keyed by `producerId`, attach `consumer.track` to a `MediaStream` → `<audio>` (or expose the stream for the UI), record `participantId → producerId`, then send `voice.resume {producerId}`. (A `voice.consume` may get **no** reply if caps incompatible — silent skip, don't block.)

**New peer mid-call:** `voice.new_producer {participantId, producerId}` → engine issues `voice.consume`/`voice.consumer`/`voice.resume` exactly as above (the "existing peers consume the newcomer" half).

**Peer left:** `voice.peer_left {participantId}` → look up the producerId(s) for that participant, `consumer.close()`, drop the `<audio>`/stream, remove from participant list + maps.

**Mute:** `toggleMute()` → `producer.pause()`/`producer.resume()` locally and send `voice.state {muted}`. Rapid toggles converge because state is set to the final boolean before/after send. **Deafen:** local only — mute/pause inbound playback (e.g. `audio.muted = true` on all elements, or set track.enabled) and send `voice.state {muted, deafened}` for peer UI; no server media effect.

**Peer state:** `voice.state {userId, participantId, muted, deafened}` → update that participant's reactive flags for UI.

**Leave / teardown:** `leave()` sends `voice.leave {}`, then closes `producer`, all `consumer`s, both `transport`s, stops every mic `MediaStream` track (mic indicator off), clears the `Device` reference and all reactive state. Triggered also from gateway `disconnect()` and the 4001 path. No dangling streams/transports.

**Voice frames over the existing socket:** all `voice.*` client→server ops are sent through the gateway's socket (`socket.send(JSON.stringify(...))`); all `voice.*` server→client frames arrive in the gateway's `ws.onmessage`/`handleFrame`. The engine must hook in via the gateway (a `sendVoice` method + a frame route/subscription), **not** a second WebSocket — per the contract ("single gateway socket `/ws`") and feature constraint ("Voice signaling rides the existing WS gateway, not a second socket").

## Decisions Made

1. **The voice engine shares the gateway socket via gateway-mediated send + a frame route.** The gateway owns `socket` (module-local, not exported). Rather than expose the raw socket (which would leak WS internals and break the authStore/gateway/channelStore separation), add a narrow `gateway.sendVoice(op, d)` (guards `readyState === OPEN`, mirrors `sendMessage`) and route inbound `voice.*` frames from the gateway's `handleFrame` into the voice module. To avoid a circular import (gateway already imports types; voice will import gateway for `sendVoice`), the cleanest seam is a **listener registration**: the gateway exposes `onVoiceFrame(handler)` (or a generic frame subscription) that the voice module registers in its init; `handleFrame`'s `default`/`voice.*` branch invokes the registered handler. This keeps the gateway dependency one-directional (voice → gateway) and mirrors the existing one-way store dependencies (gateway → authStore).

2. **Voice teardown is wired into the gateway lifecycle.** Because a WS disconnect/4001 must tear voice down cleanly (acceptance criterion), the voice module registers a teardown that `gateway.disconnect()` and the 4001 path invoke — either by the voice module subscribing to a gateway "closed" signal, or by App calling `voice.leave()/teardown()` alongside `gateway.disconnect()`/`clearAuthFailed()` (lines 47/59 of App.svelte). Prefer the gateway-driven hook so all socket consumers tear down from one place.

3. **`voiceChannelId` is threaded through presence for "who's in voice".** The gateway's `presence.update` handler currently copies only `status`, dropping `voiceChannelId`; the `ready` handler stores members verbatim (so `ready.members[].voiceChannelId` is already preserved). Update the `presence.update` case to also set `voiceChannelId` on the member so the "who's in voice" set is reactive and reconnect reconciles from the `ready` snapshot (contract `presence.update.voiceChannelId` semantics). The voice store's own `participants` list is the SFU-level truth for the local call; the per-user `voiceChannelId` on members drives the broader presence indicator (story 005's concern, but the data plumbing belongs here).

4. **Remote audio is exposed as `MediaStream`s for the UI, with `<audio>` attachment owned by the store.** The contract says "attach each remote track to an `<audio>` element (or expose remote `MediaStream`s for the UI)". Simplest reactive approach: the store creates one `MediaStream` per consumer and either (a) creates/attaches a detached `<audio>` element programmatically (works without a component mounting), or (b) exposes a reactive list of `{participantId, stream}` for story 005 to bind `<audio srcObject>`. Programmatic `<audio>` (option a) keeps playback alive independent of UI mount and matches "the store is the single owner/teardown point"; deafen then toggles `audio.muted`. Final choice deferred to plan, but the store owns playback either way.

5. **mediasoup params stay `unknown` end-to-end.** The contract passes `rtpCapabilities`/`iceParameters`/`iceCandidates`/`dtlsParameters`/`rtpParameters` through verbatim as `unknown`. The client casts them into mediasoup-client's typed APIs at the call site (`device.load`, `createSendTransport`, `consume`, etc.) — the `ServerFrame` voice payloads keep these `unknown`, matching the gateway-boundary typing in the contract.

## Open Questions

None — the contract is fully specified and the client patterns are clear. The `<audio>`-vs-exposed-`MediaStream` choice and the exact gateway send/subscribe seam are design decisions for the plan, not blockers.
