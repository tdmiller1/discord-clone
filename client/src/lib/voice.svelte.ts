/**
 * Reactive voice engine (Svelte 5 runes). Lives in a *.svelte.ts module so $state works
 * outside a component and the mediasoup objects survive re-renders with one teardown point
 * (mirrors gateway.svelte.ts / authStore.svelte.ts).
 *
 * Drives the full mediasoup-client SFU negotiation (getUserMedia → Device.load → send+recv
 * Transports → produce the mic → consume every peer) over the EXISTING /ws gateway socket via
 * the narrow gateway.sendVoice / gateway.onVoiceFrame / gateway.onVoiceTeardown seam — it never
 * opens a second WebSocket. The dependency is one-directional (voice → gateway).
 *
 * UI-facing facts (status, voiceChannelId, participants, muted, deafened, error) are $state;
 * the mediasoup Device/Transport/Producer/Consumer, the mic MediaStream, the per-producer
 * <audio> elements, and the request/reply promise resolvers are NON-reactive module locals.
 * Story 005's UI consumes this via contracts/voice-store.md.
 */
import { Device } from "mediasoup-client";
import type { Consumer, Producer, Transport } from "mediasoup-client/types";
import { gateway } from "./gateway.svelte";
import type {
  ServerFrame,
  VoiceConnectedPayload,
  VoiceConsumerPayload,
  VoiceJoinedPayload,
  VoiceProducedPayload,
  VoiceTransportPayload,
} from "./types";

export type VoiceStatus = "idle" | "joining" | "connected" | "error";

export interface VoiceParticipant {
  participantId: string;
  userId: number | null; // known once a voice.state arrives for that peer; null otherwise
  muted: boolean;
  deafened: boolean;
}

// ── Reactive UI-facing state ($state) ───────────────────────────────────────────────────────
let _status = $state<VoiceStatus>("idle");
let _voiceChannelId = $state<number | null>(null);
let _participants = $state<VoiceParticipant[]>([]);
let _muted = $state(false);
let _deafened = $state(false);
let _error = $state<string | null>(null);
// Live audio levels (0..1) for visual proof the pipeline carries sound. _localLevel is the
// mic input (proves capture); _levels maps participantId → inbound level (proves a peer's
// audio is arriving). _audioBlocked flags when the browser refused to autoplay remote audio
// (iOS Safari) so the UI can offer a one-tap unblock.
let _localLevel = $state(0);
let _levels = $state<Record<string, number>>({});
let _audioBlocked = $state(false);

// ── Non-reactive module locals (SDK objects, streams, audio, resolvers) ──────────────────────
let device: Device | null = null;
let sendTransport: Transport | null = null;
let recvTransport: Transport | null = null;
let producer: Producer | null = null;
let micStream: MediaStream | null = null;
let participantId: string | null = null;

const consumers = new Map<string, Consumer>(); // producerId → Consumer
const audioEls = new Map<string, HTMLAudioElement>(); // producerId → playback element
const producersByParticipant = new Map<string, string[]>(); // participantId → producerIds

// WebAudio metering (non-reactive): one shared context, an analyser on the mic, and one per
// remote producer. Analysers are pure sinks (never connected to destination) so they add no echo.
let audioCtx: AudioContext | null = null;
let micAnalyser: AnalyserNode | null = null;
const remoteAnalysers = new Map<string, AnalyserNode>(); // producerId → analyser
let levelRaf: number | null = null;

// Pending request/reply resolvers for ops with no transport-event callback.
let pendingJoined: ((p: VoiceJoinedPayload) => void) | null = null;
const pendingTransport = new Map<"send" | "recv", (p: VoiceTransportPayload) => void>();
const pendingConnected = new Map<"send" | "recv", () => void>();
let pendingProduced: ((p: VoiceProducedPayload) => void) | null = null;

/** Reassign $state participants after mutating the backing entries (Svelte 5 arrays aren't
 * deeply reactive for in-place edits — mirror the gateway's Map-reassign pattern). */
function commitParticipants(): void {
  _participants = [..._participants];
}

/** Upsert a participant into the reactive list (no-op if already present and unchanged). */
function upsertParticipant(pid: string): VoiceParticipant {
  let p = _participants.find((x) => x.participantId === pid);
  if (!p) {
    p = { participantId: pid, userId: null, muted: false, deafened: false };
    _participants = [..._participants, p];
  }
  return p;
}

function removeParticipant(pid: string): void {
  _participants = _participants.filter((x) => x.participantId !== pid);
}

/** Wait for the voice.joined reply (single-slot resolver). A voice.error resolves it too (with
 * a sentinel) so join() never hangs on a failed negotiation. */
function awaitJoined(): Promise<VoiceJoinedPayload> {
  return new Promise((resolve) => {
    pendingJoined = resolve;
  });
}

function awaitTransport(direction: "send" | "recv"): Promise<VoiceTransportPayload> {
  return new Promise((resolve) => {
    pendingTransport.set(direction, resolve);
  });
}

function awaitConnected(direction: "send" | "recv"): Promise<void> {
  return new Promise((resolve) => {
    pendingConnected.set(direction, resolve);
  });
}

function awaitProduced(): Promise<VoiceProducedPayload> {
  return new Promise((resolve) => {
    pendingProduced = resolve;
  });
}

/** Wire a created transport's "connect"/"connectionstatechange" events; the send transport also
 * gets a "produce" event. All client→server ops go through gateway.sendVoice. */
function wireTransport(transport: Transport, direction: "send" | "recv"): void {
  transport.on("connect", ({ dtlsParameters }, callback, errback) => {
    const sent = gateway.sendVoice("voice.connect", { direction, dtlsParameters });
    if (!sent) {
      errback(new Error("socket closed"));
      return;
    }
    awaitConnected(direction).then(callback, errback);
  });

  if (direction === "send") {
    transport.on("produce", ({ rtpParameters }, callback, errback) => {
      const sent = gateway.sendVoice("voice.produce", { rtpParameters });
      if (!sent) {
        errback(new Error("socket closed"));
        return;
      }
      awaitProduced().then(({ producerId }) => callback({ id: producerId }), errback);
    });
  }

  transport.on("connectionstatechange", (state) => {
    if (state === "failed" || state === "disconnected") {
      _error = `voice transport ${state}`;
      _status = "error";
    }
  });
}

/** Consume one remote producer: request → recvTransport.consume → wire <audio> → resume.
 * A voice.consume with no voice.consumer reply (caps-incompatible) is a silent skip — we do
 * NOT await, we react to the frame in handleVoiceFrame. */
function consumeProducer(peerId: string, producerId: string): void {
  if (device === null) return;
  const list = producersByParticipant.get(peerId) ?? [];
  if (!list.includes(producerId)) list.push(producerId);
  producersByParticipant.set(peerId, list);
  upsertParticipant(peerId);
  commitParticipants();
  gateway.sendVoice("voice.consume", {
    producerId,
    rtpCapabilities: device.rtpCapabilities,
  });
}

/** Lazily create the shared AudioContext (handles the webkit-prefixed iOS Safari name). */
function ensureAudioCtx(): AudioContext | null {
  if (audioCtx === null) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor === undefined) return null;
    audioCtx = new Ctor();
  }
  return audioCtx;
}

/** RMS amplitude of an analyser's current frame, scaled to a visible-for-speech 0..1. */
function levelOf(analyser: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 3);
}

/** Reverse-lookup the participant that owns a producer id. */
function participantOf(producerId: string): string | null {
  for (const [pid, ids] of producersByParticipant) {
    if (ids.includes(producerId)) return pid;
  }
  return null;
}

/** Attach an analyser to a MediaStream for level metering. Best-effort; never throws out. */
function meter(producerId: string | null, stream: MediaStream): void {
  const ctx = ensureAudioCtx();
  if (ctx === null) return;
  try {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    if (producerId === null) micAnalyser = analyser;
    else remoteAnalysers.set(producerId, analyser);
  } catch {
    /* metering is a diagnostic nicety; ignore unsupported-source errors */
  }
}

/** Drive _localLevel + _levels from the analysers on each animation frame. Idempotent. */
function startLevelLoop(): void {
  if (levelRaf !== null) return;
  const buf = new Uint8Array(new ArrayBuffer(2048));
  const tick = (): void => {
    if (micAnalyser !== null) _localLevel = levelOf(micAnalyser, buf);
    if (remoteAnalysers.size > 0) {
      const next: Record<string, number> = {};
      for (const [producerId, analyser] of remoteAnalysers) {
        const pid = participantOf(producerId);
        if (pid === null) continue;
        next[pid] = Math.max(next[pid] ?? 0, levelOf(analyser, buf));
      }
      _levels = next;
    }
    levelRaf = requestAnimationFrame(tick);
  };
  levelRaf = requestAnimationFrame(tick);
}

/** Tear down all metering: stop the loop, drop analysers, close the context, zero the levels. */
function stopMetering(): void {
  if (levelRaf !== null) {
    cancelAnimationFrame(levelRaf);
    levelRaf = null;
  }
  micAnalyser?.disconnect();
  micAnalyser = null;
  for (const analyser of remoteAnalysers.values()) analyser.disconnect();
  remoteAnalysers.clear();
  if (audioCtx !== null) {
    void audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  _localLevel = 0;
  _levels = {};
  _audioBlocked = false;
}

/** Resume the audio context + (re)play every remote element from a user gesture (iOS unblock). */
async function enableAudio(): Promise<void> {
  try {
    await ensureAudioCtx()?.resume();
  } catch {
    /* ignore */
  }
  await Promise.allSettled([...audioEls.values()].map((a) => a.play()));
  _audioBlocked = false;
}

/** Finish a consume once voice.consumer arrives: build the Consumer + a playback <audio>. */
async function onConsumer(d: VoiceConsumerPayload): Promise<void> {
  if (recvTransport === null) return;
  // The producer must be one we requested; find which participant it belongs to.
  let peerId: string | null = null;
  for (const [pid, ids] of producersByParticipant) {
    if (ids.includes(d.producerId)) {
      peerId = pid;
      break;
    }
  }
  try {
    const consumer = await recvTransport.consume({
      id: d.id,
      producerId: d.producerId,
      kind: d.kind,
      rtpParameters: d.rtpParameters as Parameters<Transport["consume"]>[0]["rtpParameters"],
    });
    consumers.set(d.producerId, consumer);

    const stream = new MediaStream([consumer.track]);
    const audio = new Audio();
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.muted = _deafened;
    // iOS Safari refuses to play a *detached* media element, and wants playsinline. Attach it
    // to the DOM (hidden) so playback can actually start.
    audio.setAttribute("playsinline", "");
    audio.style.display = "none";
    document.body.appendChild(audio);
    void audio.play().catch(() => {
      // Autoplay blocked (typically iOS Safari before a gesture). Surface it so the UI can
      // offer a one-tap unblock; the track stays live and metering still works meanwhile.
      _audioBlocked = true;
    });
    audioEls.set(d.producerId, audio);
    meter(d.producerId, stream);

    if (peerId !== null) {
      upsertParticipant(peerId);
      commitParticipants();
    }
    // The server created the consumer PAUSED — resume it now that the receiving side is wired.
    gateway.sendVoice("voice.resume", { producerId: d.producerId });
  } catch {
    _error = "failed to consume a peer";
  }
}

/** Close + drop every consumer/audio for a participant, and remove it from the list. */
function dropParticipant(peerId: string): void {
  const ids = producersByParticipant.get(peerId) ?? [];
  for (const producerId of ids) {
    consumers.get(producerId)?.close();
    consumers.delete(producerId);
    const audio = audioEls.get(producerId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
      audioEls.delete(producerId);
    }
    remoteAnalysers.get(producerId)?.disconnect();
    remoteAnalysers.delete(producerId);
  }
  producersByParticipant.delete(peerId);
  removeParticipant(peerId);
}

/** Inbound voice.* router (registered with gateway.onVoiceFrame). */
function handleVoiceFrame(frame: ServerFrame): void {
  switch (frame.op) {
    case "voice.joined":
      pendingJoined?.(frame.d);
      pendingJoined = null;
      break;
    case "voice.transport":
      pendingTransport.get(frame.d.direction)?.(frame.d);
      pendingTransport.delete(frame.d.direction);
      break;
    case "voice.connected":
      pendingConnected.get(frame.d.direction)?.();
      pendingConnected.delete(frame.d.direction);
      break;
    case "voice.produced":
      pendingProduced?.(frame.d);
      pendingProduced = null;
      break;
    case "voice.consumer":
      void onConsumer(frame.d);
      break;
    case "voice.resumed":
      break; // ack — audio now flows; nothing reactive to update
    case "voice.new_producer":
      consumeProducer(frame.d.participantId, frame.d.producerId);
      break;
    case "voice.peer_left":
      dropParticipant(frame.d.participantId);
      break;
    case "voice.state": {
      const p = _participants.find((x) => x.participantId === frame.d.participantId);
      if (p) {
        p.userId = frame.d.userId;
        p.muted = frame.d.muted;
        p.deafened = frame.d.deafened;
        commitParticipants();
      }
      break;
    }
    case "voice.error":
      _error = frame.d.message;
      // Unblock a pending join so join() doesn't hang on a failed negotiation.
      pendingJoined?.({ channelId: 0, participantId: "", rtpCapabilities: {}, producers: [] });
      pendingJoined = null;
      break;
    default:
      break; // non-voice frames never reach here (gateway routes only voice.*)
  }
}

/** Create + wire a transport from a voice.transport reply. */
function buildTransport(d: VoiceTransportPayload): Transport {
  if (device === null) throw new Error("device not loaded");
  const params = {
    id: d.id,
    iceParameters: d.iceParameters,
    iceCandidates: d.iceCandidates,
    dtlsParameters: d.dtlsParameters,
  } as Parameters<Device["createSendTransport"]>[0];
  const transport =
    d.direction === "send"
      ? device.createSendTransport(params)
      : device.createRecvTransport(params);
  wireTransport(transport, d.direction);
  return transport;
}

/** Capture mic + run the full SFU negotiation. Mic denial / socket-drop surface as reactive
 * error and reset to idle WITHOUT a half-join (no voice.join sent). Idempotent: a join while
 * already in a call tears the old one down first (never two mic tracks). */
async function join(channelId: number): Promise<void> {
  if (_status === "joining") return;
  if (_status === "connected" || _voiceChannelId !== null) teardown(true);

  _error = null;
  _status = "joining";
  // Create + resume the AudioContext synchronously inside the click gesture so iOS Safari
  // unlocks audio for the remote elements we'll create later.
  void ensureAudioCtx()?.resume();

  // 1. Mic capture — a rejection (denied / no device) aborts the join cleanly.
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    _error = "microphone permission denied or unavailable";
    _status = "idle";
    micStream = null;
    return;
  }

  // 2. voice.join → voice.joined.
  if (!gateway.sendVoice("voice.join", { channelId })) {
    _error = "not connected";
    _status = "idle";
    stopMic();
    return;
  }
  let joined: VoiceJoinedPayload;
  try {
    joined = await awaitJoined();
    if (_error !== null) {
      // a voice.error unblocked the join — abort.
      stopMic();
      _status = "error";
      return;
    }
  } catch {
    _error = "failed to join voice";
    _status = "error";
    stopMic();
    return;
  }

  participantId = joined.participantId;
  _voiceChannelId = joined.channelId;

  try {
    // 3. Load the Device with the router caps.
    device = new Device();
    await device.load({
      routerRtpCapabilities: joined.rtpCapabilities as Parameters<
        Device["load"]
      >[0]["routerRtpCapabilities"],
    });

    // 4. Create both transports.
    gateway.sendVoice("voice.transport", { direction: "send" });
    sendTransport = buildTransport(await awaitTransport("send"));
    gateway.sendVoice("voice.transport", { direction: "recv" });
    recvTransport = buildTransport(await awaitTransport("recv"));

    // 5/6. Produce the mic track (triggers the "produce" event wired above).
    const track = micStream.getAudioTracks()[0];
    if (track) {
      producer = await sendTransport.produce({ track });
    }

    // Mic level meter (proof of capture) + start the per-frame level loop.
    if (micStream !== null) meter(null, micStream);
    startLevelLoop();

    // 7. Consume every producer already in the room.
    for (const { participantId: peerId, producerId } of joined.producers) {
      consumeProducer(peerId, producerId);
    }

    _status = "connected";
  } catch {
    _error = "voice negotiation failed";
    _status = "error";
    teardown(true);
  }
}

/** Toggle local outbound mute: pause/resume the producer + relay voice.state. Convergent under
 * rapid toggles (state set to the final boolean before the send). */
function toggleMute(): void {
  _muted = !_muted;
  if (producer) {
    if (_muted) producer.pause();
    else producer.resume();
  }
  gateway.sendVoice("voice.state", { muted: _muted, deafened: _deafened });
}

/** Toggle local inbound playback mute (deafen). Local media only — relayed for peer UI. */
function toggleDeafen(): void {
  _deafened = !_deafened;
  for (const audio of audioEls.values()) audio.muted = _deafened;
  gateway.sendVoice("voice.state", { muted: _muted, deafened: _deafened });
}

/** Stop + drop the mic stream (mic indicator off). */
function stopMic(): void {
  if (micStream) {
    for (const track of micStream.getTracks()) track.stop();
    micStream = null;
  }
}

/** Single teardown point: close producer/consumers/transports, stop the mic, drop all audio,
 * and reset every reactive field. `notify` controls whether voice.leave is sent (false when the
 * socket is already gone — the gateway teardown path). */
function teardown(notify: boolean): void {
  if (notify && _voiceChannelId !== null) gateway.sendVoice("voice.leave", {});

  producer?.close();
  producer = null;

  for (const consumer of consumers.values()) consumer.close();
  consumers.clear();

  for (const audio of audioEls.values()) {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  }
  audioEls.clear();
  producersByParticipant.clear();
  stopMetering();

  sendTransport?.close();
  sendTransport = null;
  recvTransport?.close();
  recvTransport = null;

  stopMic();
  device = null;
  participantId = null;

  pendingJoined = null;
  pendingTransport.clear();
  pendingConnected.clear();
  pendingProduced = null;

  _voiceChannelId = null;
  _participants = [];
  _muted = false;
  _deafened = false;
  _status = "idle";
}

// Register the inbound route + gateway-driven teardown once at module load (the socket-gone
// teardown skips the voice.leave send).
gateway.onVoiceFrame(handleVoiceFrame);
gateway.onVoiceTeardown(() => teardown(false));

/** The reactive voice engine singleton. Read fields directly (e.g. voice.status). */
export const voice = {
  /** idle | joining | connected | error. */
  get status(): VoiceStatus {
    return _status;
  },
  /** The joined voice channel id, or null when not in voice. */
  get voiceChannelId(): number | null {
    return _voiceChannelId;
  },
  /** Remote peers in the call (excludes self). */
  get participants(): VoiceParticipant[] {
    return _participants;
  },
  /** Local outbound mute. */
  get muted(): boolean {
    return _muted;
  },
  /** Local inbound playback mute (deafen). */
  get deafened(): boolean {
    return _deafened;
  },
  /** mic-denied / transport-failed / voice.error message, or null. */
  get error(): string | null {
    return _error;
  },
  /** Local mic input level, 0..1 (proof the mic is capturing, independent of mute). */
  get localLevel(): number {
    return _localLevel;
  },
  /** Inbound audio level, 0..1, for a participant (proof their audio is arriving). */
  levelFor(participantId: string): number {
    return _levels[participantId] ?? 0;
  },
  /** True when the browser blocked remote audio autoplay (offer enableAudio from a gesture). */
  get audioBlocked(): boolean {
    return _audioBlocked;
  },
  /** Resume playback of all remote audio from a user gesture (iOS Safari unblock). */
  enableAudio(): Promise<void> {
    return enableAudio();
  },

  /** Capture the mic + negotiate the SFU session. Sets `error` on failure (never throws). */
  join(channelId: number): Promise<void> {
    return join(channelId);
  },
  /** Send voice.leave + full teardown. */
  leave(): void {
    teardown(true);
  },
  /** Pause/resume the producer + relay voice.state. */
  toggleMute(): void {
    toggleMute();
  },
  /** Mute/unmute inbound playback + relay voice.state. */
  toggleDeafen(): void {
    toggleDeafen();
  },
  /** Socket-gone teardown (no voice.leave send). Idempotent. */
  teardown(): void {
    teardown(false);
  },
};
