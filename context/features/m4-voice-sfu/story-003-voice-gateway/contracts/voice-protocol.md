#contract

# Contract: Voice WS signaling protocol (M4 story 003)

Authoritative wire contract for the `voice.*` WebSocket ops. **Story 004 (the client voice
engine, mediasoup-client) implements against exactly this.** All frames use the existing
`{ "op": <string>, "d": <object> }` envelope (`SPEC.md §7`) over the single gateway socket
(`/ws`). Voice ops are only honored on an **already-authed** socket (one that has completed
`identify` and received `ready`); voice frames on an un-authed socket are ignored.

The gateway is a **thin relay** over the SFU core (story 002 `VoiceSfu`). mediasoup param
objects (`rtpCapabilities`, `iceParameters`, `iceCandidates`, `dtlsParameters`, `rtpParameters`)
are **passed through verbatim** in both directions — the gateway never inspects them. Their
concrete types are mediasoup's (`import type { types } from "mediasoup"`); they are typed
`unknown` at the gateway boundary and fed straight into the client's mediasoup-client `Device`.

Tolerance rules (all enforced):
- A **malformed/invalid** voice frame (bad `d`, wrong field types, unknown `voice.*` op) is
  **silently dropped** — no reply, the socket stays open.
- A voice op that requires being in voice but is sent before `voice.join` gets a
  `voice.error {op, message:"not in voice"}` (no SFU call is made).
- Any SFU rejection (e.g. unknown channel/participant) is caught, logged, and answered with a
  single `voice.error {op, message:"voice operation failed"}` to the requesting socket. **A
  failed voice op never closes the socket.**

---

## Ops: client → server

```ts
/** voice.join — join the seeded voice channel. */
interface VoiceJoinPayload { channelId: number; }

/** voice.transport — request a send|recv WebRtcTransport (call once per direction). */
interface VoiceTransportRequestPayload { direction: "send" | "recv"; }

/** voice.connect — complete DTLS for the named transport. */
interface VoiceConnectPayload { direction: "send" | "recv"; dtlsParameters: unknown; }

/** voice.produce — publish the mic track (over the "send" transport). */
interface VoiceProducePayload { rtpParameters: unknown; }

/** voice.consume — consume a remote producer; server replies with a *paused* consumer. */
interface VoiceConsumePayload { producerId: string; rtpCapabilities: unknown; }

/** voice.resume — resume a consumer after the client has wired its receiving side. */
interface VoiceResumePayload { producerId: string; }

/** voice.state — mute/deafen toggle. `deafened` is local playback only (relayed, no server effect). */
interface VoiceStatePayload { muted: boolean; deafened?: boolean; }

/** voice.leave — leave the voice channel. No fields. */
interface VoiceLeavePayload {}
```

## Ops: server → client

```ts
/** voice.joined — ack of voice.join: router caps to Device.load + existing producers to consume. */
interface VoiceJoinedPayload {
  channelId: number;
  participantId: string;                                       // this socket's SFU participant id
  rtpCapabilities: unknown;                                    // router RTP caps → Device.load({ routerRtpCapabilities })
  producers: { participantId: string; producerId: string }[];  // existing producers (consume each)
}

/** voice.transport — created transport params → Device.createSend/RecvTransport(...). */
interface VoiceTransportPayload {
  direction: "send" | "recv";
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown;
  dtlsParameters: unknown;
}

/** voice.connected — ack of voice.connect (resolve the transport "connect" event). */
interface VoiceConnectedPayload { direction: "send" | "recv"; }

/** voice.produced — ack of voice.produce (resolve the transport "produce" event). */
interface VoiceProducedPayload { producerId: string; }

/** voice.consumer — consume params → recvTransport.consume(...); the consumer is created PAUSED. */
interface VoiceConsumerPayload {
  id: string;            // consumer id
  producerId: string;    // the remote producer being consumed
  kind: "audio";         // always "audio" in M4
  rtpParameters: unknown;
}

/** voice.resumed — ack of voice.resume. */
interface VoiceResumedPayload { producerId: string; }

/** voice.new_producer — a peer started producing; issue a voice.consume for it. */
interface VoiceNewProducerPayload { participantId: string; producerId: string; }

/** voice.peer_left — a peer left/disconnected; close its consumer / remove its <audio>. */
interface VoicePeerLeftPayload { participantId: string; }

/** voice.state — a peer's mute/deafen changed (relay for UI). */
interface VoiceStateUpdatePayload {
  userId: number;
  participantId: string;
  muted: boolean;
  deafened: boolean;
}

/** voice.error — a voice op failed for this socket. The socket stays open. */
interface VoiceErrorPayload { op: string; message: string; }
```

`ClientCommand` gains: `voice.join`, `voice.transport`, `voice.connect`, `voice.produce`,
`voice.consume`, `voice.resume`, `voice.state`, `voice.leave`.
`ServerEvent` gains: `voice.joined`, `voice.transport`, `voice.connected`, `voice.produced`,
`voice.consumer`, `voice.resumed`, `voice.new_producer`, `voice.peer_left`, `voice.state`,
`voice.error`.

---

## Negotiation sequence (join → transport → connect → produce → consume → resume)

`participantId` is minted by the gateway **per socket** (a user on two sockets is two
participants). It is returned in `voice.joined` and is stable for the life of the socket
(a leave-then-rejoin on the same socket reuses it). The client does not send `participantId`
on any op — the gateway derives it from the socket.

```
client                                                            server (gateway → SFU)
  │  voice.join {channelId}                                      →  │  validate seeded voice channel
  │                                                                 │  mint participantId; register voice presence
  │  ← voice.joined {channelId, participantId, rtpCapabilities,     │  (broadcasts presence.update on first-in-voice)
  │                  producers:[{participantId, producerId}, …]}    │
  │  Device.load({ routerRtpCapabilities: rtpCapabilities })       │
  │                                                                 │
  │  voice.transport {direction:"send"}                          →  │  sfu.createTransport(send)
  │  ← voice.transport {direction:"send", id, iceParameters,        │
  │                     iceCandidates, dtlsParameters}              │
  │  Device.createSendTransport(...)                                │
  │  voice.transport {direction:"recv"}                          →  │  sfu.createTransport(recv)
  │  ← voice.transport {direction:"recv", …}                        │
  │  Device.createRecvTransport(...)                                │
  │                                                                 │
  │  (sendTransport "connect" event)                                │
  │  voice.connect {direction:"send", dtlsParameters}            →  │  sfu.connectTransport(send, dtls)
  │  ← voice.connected {direction:"send"}    // resolve connect      │
  │  (recvTransport "connect" event likewise → voice.connect recv)  │
  │                                                                 │
  │  (sendTransport "produce" event)                                │
  │  voice.produce {rtpParameters}                              →   │  sfu.produce(...) → producerId
  │  ← voice.produced {producerId}           // resolve produce      │  AND → voice.new_producer to every OTHER peer
  │                                                                 │
  │  // consume each producer from voice.joined.producers AND any   │
  │  // voice.new_producer received afterwards:                     │
  │  voice.consume {producerId, rtpCapabilities}                →   │  sfu.consume(...) → paused consumer (or null)
  │  ← voice.consumer {id, producerId, kind:"audio", rtpParameters} │  (no reply if caps incompatible → null)
  │  recvTransport.consume(...)  // wire <audio>                    │
  │  voice.resume {producerId}                                  →   │  sfu.resumeConsumer(...)
  │  ← voice.resumed {producerId}            // audio now flows      │
```

Key points:
- **Consume is client-driven.** The server never pushes a `voice.consumer`; the client issues
  one `voice.consume` per producer it learns about (from `voice.joined.producers` for existing
  producers, and from each `voice.new_producer` for peers that join/produce later).
- **Consumers are created paused.** No audio flows for a consumer until the client sends
  `voice.resume` for that `producerId` (after it has wired the receiving side). This is the
  SFU's paused-consumer handshake.
- **`voice.consume` may yield nothing.** If the client's `rtpCapabilities` are incompatible
  (`!router.canConsume`), the SFU returns `null` and the gateway sends **no** `voice.consumer`
  for that producer (silent skip — not an error).
- **Mic is optional.** A client may `voice.join` and consume without ever calling
  `voice.produce` (listen-only / mic-denied). Peers simply never receive a `voice.new_producer`
  for it.
- **Idempotent re-join.** A second `voice.join` on the same socket reuses the existing
  `participantId` and re-sends `voice.joined`; the SFU replaces (not duplicates) any prior
  transport/producer, so no second mic track is created.

## New-producer / peer-left notifications

- **`voice.new_producer {participantId, producerId}`** is pushed to every *other* socket in the
  room when a peer calls `voice.produce`. Recipients respond with `voice.consume {producerId,
  rtpCapabilities}` (then `voice.resume`). This is the "existing peers consume the newcomer"
  half of the bidirectional wiring; the "newcomer consumes existing" half is
  `voice.joined.producers`.
- **`voice.peer_left {participantId}`** is pushed to every *other* socket in the room when a
  peer leaves (via `voice.leave`) or disconnects (socket close, error, or heartbeat reap).
  Recipients close that participant's consumer and remove its `<audio>` element. The
  notification carries `participantId`; a client maps it to the consumer(s) it created for that
  peer's `producerId`(s) (learned from `voice.joined.producers` / `voice.new_producer`).

## Mute / deafen

`voice.state {muted, deafened?}`:
- `muted:true` pauses this participant's producer on the server (peers stop receiving audio);
  `muted:false` resumes it. Both are idempotent no-ops if the participant has no producer.
- `deafened` is **local playback only** — the server makes no media change; it is relayed for
  UI so peers can show a deafened indicator (`deafened` defaults to `false` when omitted).
- The change is relayed to every *other* room peer as
  `voice.state {userId, participantId, muted, deafened}`.

## `presence.update.voiceChannelId` semantics

The existing `PresenceUpdatePayload {userId, status, voiceChannelId}` is reused **unchanged**.
Voice membership is tracked per-user (any in-voice socket ⇒ the user is in voice), mirroring
online/offline:
- On a user's **first** socket entering voice, the gateway broadcasts
  `presence.update {userId, status:"online", voiceChannelId:<channelId>}` to everyone except the
  joining socket.
- On the user's **last** in-voice socket leaving, it broadcasts
  `presence.update {userId, status:"online", voiceChannelId:null}`.
- `status` stays `"online"` across both transitions (the user is still connected; voice is
  orthogonal to online/offline).
- **Reconnect reconciliation:** `ready.members[].voiceChannelId` reflects the live registry
  value, so a client that missed a `presence.update` while disconnected reconciles voice
  membership from the `ready` snapshot.

## Teardown guarantees

Leaving voice — whether via `voice.leave` or any disconnect (socket close, error, or the
heartbeat revocation reaper) — runs a single shared path that:
1. closes the participant's SFU transports/producer/consumers (`sfu.closeParticipant`),
2. pushes `voice.peer_left {participantId}` to the other room peers,
3. removes the socket from the voice registry and, on the per-user last-in-voice transition,
   broadcasts `presence.update {voiceChannelId:null}`.

No transports leak, and a multi-socket user losing one socket keeps their other voice
session(s) intact.
