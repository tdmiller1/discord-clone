#research

# Research: Server — mediasoup SFU core (worker, router, voice rooms)

## Files to Touch

### Likely Modified
- `server/package.json` — add `mediasoup` to `dependencies` (the only new prod dep). No client dep here (that's story 004). Bump nothing else.
- `server/src/app.ts` — construct the `VoiceSfu` service once in `buildApp` (mirroring `const hub = new BroadcastHub()`), initialize its worker/router (async — see Open Questions / Decisions), and register an `onClose` hook that closes the worker/router. The service is passed into the gateway later (story 003) the same way `hub` is passed to `wsGateway`. This story only needs to construct + dispose it; no gateway wiring.
- `server/Dockerfile` — mediasoup ships a prebuilt worker binary but its npm `postinstall` may still compile/download; ensure the build stage has the toolchain. The build stage already installs `python3 make g++` (for `better-sqlite3`), which is exactly what mediasoup's worker build needs. Verify `npm ci` succeeds and the prebuilt worker is copied with `node_modules` into the runtime stage. The runtime stage is `node:24-bookworm-slim` (glibc) — mediasoup's prebuilt worker targets glibc, so this is compatible (NOT alpine/musl). Add a note/comment if any extra apt dep is required at build time.

### Likely Created
- `server/src/voice/sfu.ts` — the `VoiceSfu` service: a plain class (no Fastify import) owning the mediasoup `Worker` + `Router`, plus the per-channel room registry and the per-participant API (RTP caps, create/connect transport, produce, consume, pause/resume, list producers, close participant). Mirrors `server/src/ws/hub.ts` / `presence.ts` shape (a plain class constructed in `buildApp`).
- `server/src/voice/room.ts` — (optional split) the per-voice-channel `VoiceRoom` abstraction tracking participants; may live inside `sfu.ts` instead. See Decisions.
- `context/features/m4-voice-sfu/story-002-sfu-core/contracts/sfu-core.md` — the `provides_contract`. Documents the public method signatures and returned data shapes (router RTP capabilities, transport connect params, producer/consumer ids) that the gateway (story 003) relays to clients.

### Read-Only Reference (patterns to follow)
- `server/src/ws/hub.ts` — `BroadcastHub`: the canonical "plain in-memory class, framework-agnostic, constructed once in `buildApp`, shared" shape to mirror. Note the `#private` field, JSDoc style, and "blessed for ≤10 clients, no broker" framing.
- `server/src/ws/presence.ts` — `PresenceRegistry`: the `Map`-keyed registry with add/remove returning a transition flag (`firstOnline`/`lastOffline`). The room/participant registry's join/leave logic should mirror this "report the empty→non-empty / non-empty→empty transition" pattern (relevant for releasing a room when its last participant leaves).
- `server/src/app.ts` — how `BroadcastHub` is constructed and how the SQLite `db` registers an `onClose` cleanup hook (`app.addHook("onClose", async () => { db.close(); })`). The worker/router close hook copies this exactly.
- `server/src/config.ts` — `config.rtcMinPort`, `config.rtcMaxPort`, `config.publicHost` already exist and are reserved for this. NO new config needed; NO scattered `process.env`.
- `server/src/ws/gateway.ts` — not modified here, but shows the per-connection teardown pattern (the `teardown()` closure) the gateway will call into for SFU cleanup in story 003. Confirms `voice.*` is currently a no-op ("arrives in M4").
- `context/features/m1-auth-ws-presence/story-004-ws-gateway-presence/contracts/ws-protocol.md` — format/tone to copy when writing `contracts/sfu-core.md` (`#contract` tag, "Authoritative interface", explicit downstream-consumer note).

## Existing Patterns

The two collaborators this story must mirror are `BroadcastHub` and `PresenceRegistry` (`server/src/ws/`):

- **Plain class, no framework import.** Both are exported classes with `#private` fields, terse method-level JSDoc, and a module-level doc comment explaining *why* the shape exists and reaffirming "≤10 clients, no broker." `VoiceSfu` must follow this — no `import` from `fastify`/`@fastify/websocket` in the service file. (It will import mediasoup types, which is fine — those are transport-agnostic.)
- **Constructed once in `buildApp`, shared by reference.** `app.ts` does `const hub = new BroadcastHub()` then passes it to the gateway plugin via register options (`{ config, hub }`). `VoiceSfu` is constructed the same way. Unlike `hub`, it is NOT `app.decorate`'d unless story 003 needs it on `app`; for this story, constructing it and disposing it on `onClose` is the requirement. Pass-to-gateway happens in story 003.
- **Transition-reporting registry.** `PresenceRegistry.add/remove` return `{ firstOnline }`/`{ lastOffline }` so the caller broadcasts exactly on the edge. The room registry should expose the analogue: adding the first participant creates the room (lazily, on first `createTransport`/join), and removing the last participant closes + deletes the room. Keep the "is this the last one?" signal explicit so cleanup is leak-free.
- **Cleanup on `onClose`.** `app.ts` registers `app.addHook("onClose", async () => { db.close(); })`. The SFU adds a parallel hook that closes the router then the worker (`worker.close()` cascades to routers/transports/producers/consumers, but close explicitly and idempotently to be safe).

### mediasoup specifics to encode

mediasoup's object model (the service wraps these so the gateway never touches them):
- `mediasoup.createWorker({ rtcMinPort, rtcMaxPort, logLevel })` → `Worker` (a child process; **async**). One worker is plenty for ≤10 clients.
- `worker.createRouter({ mediaCodecs })` → `Router`. `mediaCodecs` carries **only Opus**: `{ kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 }`.
- `router.rtpCapabilities` → the **router RTP capabilities** the client `Device` loads. Returned by the service's `getRtpCapabilities()`.
- `router.createWebRtcTransport({ listenIps: [{ ip: "0.0.0.0", announcedIp: config.publicHost }], enableUdp: true, enableTcp: true, preferUdp: true })` → `WebRtcTransport`. The **connect params** the client needs: `{ id, iceParameters, iceCandidates, dtlsParameters }`. Media is DTLS-SRTP by default (no extra flag).
- `transport.connect({ dtlsParameters })` — completes DTLS (client→server).
- `transport.produce({ kind: "audio", rtpParameters })` → `Producer` (the mic). Returns `producer.id`.
- `transport.consume({ producerId, rtpParameters, paused })` → `Consumer`. Returns `{ id, producerId, kind, rtpParameters }` (the consume params the client uses). Convention: create consumers `paused: true`, resume after the client confirms (story 003/004 concern, but the API must allow it).
- `producer.pause()` / `producer.resume()` — backs mute (`voice.state {muted}`).

Each participant owns: a **send** `WebRtcTransport` and a **recv** `WebRtcTransport` (two transports — standard mediasoup pattern), one audio `Producer`, and a `Map` of `Consumer`s keyed by the remote producer id. Closing a participant closes both transports (which cascades to the producer/consumers) and removes it from the room.

## Data Flow

This story builds the service in isolation; the live flow is wired in story 003, but the API is shaped by it:

1. **Boot:** `buildApp(config)` → `new VoiceSfu(config)` → (async init) `createWorker({ rtcMinPort: config.rtcMinPort, rtcMaxPort: config.rtcMaxPort })` → `worker.createRouter({ mediaCodecs: [opus] })`. Worker is a child process listening on the RTC UDP range; binds fail loudly if the range is unavailable.
2. **Client joins voice (story 003 calls these):** gateway → `sfu.getRtpCapabilities()` (relayed to client `Device`) → `sfu.createTransport(channelId, participantId, "send"|"recv")` returns `{ id, iceParameters, iceCandidates, dtlsParameters }` → client connects → `sfu.connectTransport(...)` with the client's `dtlsParameters` → `sfu.produce(...)` with the client's `rtpParameters` returns a producer id.
3. **Forwarding (the SFU-lite core, SPEC §11):** when a participant produces, the gateway announces the new producer; every other participant in the room calls `sfu.consume(consumerParticipant, remoteProducerId, clientRtpCapabilities)` to receive that Opus track. The newcomer also consumes all existing producers (`sfu.listProducers(channelId)` excluding self). Server forwards; no client mesh.
4. **Mute:** `sfu.pauseProducer(...)` / `sfu.resumeProducer(...)`.
5. **Leave/disconnect (gateway `teardown()` in story 003):** `sfu.closeParticipant(channelId, participantId)` closes its transports/producer/consumers; if the room is now empty, it is released. Other participants drop the consumer for that peer.
6. **App shutdown:** `onClose` → close router + worker (child process exits).

Nothing is persisted (no DB writes); voice membership is purely in-memory, matching the feature constraint.

## Decisions Made

1. **New `server/src/voice/` directory rather than `server/src/ws/`.** SFU is a distinct concern from the WS gateway, and the feature/story scopes it as a standalone framework-agnostic service. A new directory mirrors how `routes/` and `ws/` segregate concerns. (`room.ts` may be split out or kept inline in `sfu.ts` — see #4.)

2. **Async worker init via an explicit `init()`/`ready()` method, called and awaited in `buildApp`.** `createWorker` is async but the `BroadcastHub` pattern is a synchronous constructor. The cleanest mirror: keep the constructor synchronous (store config), add an async `init()` that creates the worker+router, and `await sfu.init()` in `buildApp`. This requires `buildApp` to become `async` (it is currently sync, called as `const app = buildApp(config)` in `index.ts`). Making `buildApp` async is the minimal correct change and `index.ts` already runs at top-level `await` (it uses `await app.listen(...)`), so `const app = await buildApp(config)` is a one-line change. This is flagged as a small structural ripple; rationale: mediasoup's worker is irreducibly async and lazy-initializing it on first use would leak async into every gateway call. Alternative (rejected): a static async factory `VoiceSfu.create(config)` — also fine, but `init()` keeps construction parallel to `new BroadcastHub()`.

3. **Two transports per participant (send + recv), consumers created `paused: true`.** Standard mediasoup topology; the story explicitly says "WebRtcTransport(s) (send + recv)". Paused-on-create is the canonical mediasoup handshake (resume after client `consumer` is ready) and the API exposes resume, so encode it now.

4. **Keep the room abstraction inline in `sfu.ts` (single file) unless it grows large.** `BroadcastHub`/`PresenceRegistry` are each one small file. A `VoiceRoom` is a thin participant `Map`; co-locating it in `sfu.ts` (as a small internal class or interface + the `Map<channelId, Room>` in `VoiceSfu`) keeps the surface minimal for ≤10 clients / one room. The implementer may split `room.ts` out if it reads better — both satisfy the AC.

5. **`mediaCodecs` = Opus only, `48000`/`2 channels`.** SPEC §11 mandates Opus as the only negotiated codec; stereo `channels: 2` is mediasoup's standard Opus declaration (the mic is mono but the codec line is conventionally `2`).

6. **`announcedIp: config.publicHost`, `listenIp: "0.0.0.0"`, UDP+TCP enabled, `preferUdp`.** Matches AC #3 and SPEC §11 ("server public IP/hostname is the ICE announce address"). `0.0.0.0` listen binds all interfaces; `announcedIp` is what ICE advertises. TCP enabled as a fallback though UDP is preferred and is the exposed range.

7. **Docker: no Dockerfile change expected beyond verification.** The build stage already has `python3 make g++` (for `better-sqlite3`) which covers mediasoup's worker build, and the runtime is glibc `node:24-bookworm-slim` (mediasoup prebuilt worker is glibc-compatible — must NOT switch to alpine). The implementer should confirm `npm ci` + the prebuilt worker survive the `npm prune --omit=dev` + multi-stage copy; add a comment if an extra build dep surfaces.

## Open Questions

None blocking. The one structural ripple (making `buildApp` async, Decision #2) is resolvable from existing conventions — `index.ts` already uses top-level `await` — and is documented above rather than left open.
