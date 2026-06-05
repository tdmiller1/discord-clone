#contract

# Contract: mediasoup SFU core (`VoiceSfu`, story 002)

Authoritative interface for the M4 SFU core (SPEC.md §11, SFU-lite). **Story 003 (the
WebSocket gateway) consumes exactly what is documented here** and relays the returned
data shapes verbatim to clients (which feed them to mediasoup-client in story 004). The
gateway never touches mediasoup objects directly — it only calls these methods.

The service is **framework-agnostic** (no Fastify import), **in-memory**, sized for
**≤10 clients** (one worker, one router, no broker), and persists **nothing** (voice
membership is ephemeral; no DB writes). It is constructed once in `buildApp`
(`const sfu = new VoiceSfu(config); await sfu.init();`) and disposed on `onClose`
(`await sfu.close()`), mirroring `BroadcastHub`/`PresenceRegistry`.

Module: `server/src/voice/sfu.ts`. Import: `import { VoiceSfu } from "./voice/sfu.js";`

## Lifecycle & boot

- `new VoiceSfu(config)` — synchronous, cheap; reads only `config.rtcMinPort`,
  `config.rtcMaxPort`, `config.publicHost` (no scattered `process.env`).
- `await sfu.init()` — creates the mediasoup worker (a child process bound to the
  `rtcMinPort..rtcMaxPort` UDP range) and the **Opus-only** router. Idempotent. Rejects
  loudly if the RTC port range is unavailable, so the server fails fast at boot.
- `await sfu.close()` — closes all rooms, the router, then the worker. Idempotent; safe
  even if `init()` never ran. Wired to `app.addHook("onClose", ...)`.

The single negotiated codec (SPEC.md §11):

```ts
{ kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 }
```

`WebRtcTransport`s are created with
`listenIps: [{ ip: "0.0.0.0", announcedIp: config.publicHost }]`, `enableUdp: true`,
`enableTcp: true`, `preferUdp: true`. Media is DTLS-SRTP by default.

## Identifiers

- `channelId: number` — the voice channel id (story 001's row id). Keys a room.
- `participantId: string` — chosen by the **gateway** (story 003), **per socket**, so a
  user connected on two sockets is two participants. This service only keys on it; it
  does not assign ids.

A **room** is created lazily on the first `createTransport` for a `channelId`, and
released automatically when its last participant is closed.

## Returned data shapes

These are the exact objects the gateway relays to clients. mediasoup types are from
`import type { types } from "mediasoup"`.

```ts
// createTransport → client mediasoup-client Device.createSendTransport / createRecvTransport input
interface TransportParams {
  id: string;
  iceParameters: types.IceParameters;
  iceCandidates: types.IceCandidate[];
  dtlsParameters: types.DtlsParameters;
}

// consume → client transport.consume() input
interface ConsumeParams {
  id: string;            // consumer id
  producerId: string;    // the remote producer being consumed
  kind: types.MediaKind; // always "audio" in M4
  rtpParameters: types.RtpParameters;
}

// getRtpCapabilities → client Device.load({ routerRtpCapabilities }) input
type RtpCapabilities = types.RtpCapabilities;

// produce → { producerId } (the id the gateway announces to other participants)
// listProducers → { participantId, producerId }[] (the room's live producers)
```

`TransportParams`, `ConsumeParams`, and `TransportDirection` are **exported** from
`server/src/voice/sfu.ts`. `Participant`/`VoiceRoom` are internal and not exported.

## Public method signatures (authoritative)

```ts
type TransportDirection = "send" | "recv";

class VoiceSfu {
  constructor(config: Config);

  // Lifecycle
  init(): Promise<void>;
  close(): Promise<void>;

  // Capabilities
  getRtpCapabilities(): types.RtpCapabilities; // throws if not initialized

  // Transport negotiation (per participant, per direction)
  createTransport(
    channelId: number,
    participantId: string,
    direction: TransportDirection,
  ): Promise<TransportParams>;          // lazily creates room + participant
  connectTransport(
    channelId: number,
    participantId: string,
    direction: TransportDirection,
    dtlsParameters: types.DtlsParameters,
  ): Promise<void>;                     // completes DTLS

  // Producing (mic)
  produce(
    channelId: number,
    participantId: string,
    rtpParameters: types.RtpParameters,
  ): Promise<{ producerId: string }>;   // replaces any existing producer (idempotent)

  // Consuming (remote tracks)
  consume(
    channelId: number,
    participantId: string,
    producerId: string,
    rtpCapabilities: types.RtpCapabilities,
  ): Promise<ConsumeParams | null>;     // null if !router.canConsume; created paused: true
  resumeConsumer(
    channelId: number,
    participantId: string,
    producerId: string,
  ): Promise<void>;                     // post-handshake resume

  // Mute
  pauseProducer(channelId: number, participantId: string): void;  // no-op if no producer
  resumeProducer(channelId: number, participantId: string): void; // no-op if no producer

  // Fan-out wiring
  listProducers(
    channelId: number,
    exceptParticipantId?: string,
  ): { participantId: string; producerId: string }[];

  // Teardown
  closeParticipant(
    channelId: number,
    participantId: string,
  ): { roomEmpty: boolean };            // closes transports/producer/consumers; releases empty room
}
```

## Conventions the gateway (story 003) must honor

- **Paused-consumer handshake.** `consume()` always creates the consumer `paused: true`.
  The gateway must call `resumeConsumer()` only after the client confirms its receiving
  consumer is ready. Without the resume, no audio flows.
- **Self-exclusion on join.** A newcomer consumes existing producers via
  `listProducers(channelId, newcomerParticipantId)`; existing participants consume the
  newcomer's producer (announced from `produce()`'s `producerId`). This two-way wiring is
  the SFU-lite forwarding core — the server forwards, there is no client mesh.
- **`consume()` may return `null`.** If the client's `rtpCapabilities` are incompatible
  (`!router.canConsume`), `consume()` returns `null` (it does not throw). The gateway
  skips that producer↔consumer pair.
- **Idempotent re-join.** `createTransport` closes/replaces any prior transport for the
  same `(participant, direction)`; `produce` closes any prior producer. Re-negotiating
  never leaks transports or creates a second mic track.
- **Teardown transition signal.** `closeParticipant()` returns `{ roomEmpty }`. When
  `true`, the room was just released (its last participant left) — the analogue of
  `PresenceRegistry.remove`'s `lastOffline`. The gateway uses this to stop broadcasting
  voice state for an empty channel. It is idempotent for unknown channel/participant.
- **Error vs. tolerant no-op.** `connectTransport`, `produce`, `consume`, and
  `resumeConsumer` **throw** a clear `Error` on an unknown channel/participant (a
  deterministic failure for the gateway to surface). `pauseProducer`, `resumeProducer`,
  `listProducers`, and `closeParticipant` are **tolerant** (no-op / empty / `roomEmpty:false`)
  so teardown paths are always safe.
- **`getRtpCapabilities()` throws if `init()` has not completed.** The gateway should
  only call SFU methods after `buildApp` has finished (it always has, since `init()` is
  awaited before the server listens).
