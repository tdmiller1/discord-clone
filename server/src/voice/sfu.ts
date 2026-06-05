import { createWorker, type types } from "mediasoup";
import type { Config } from "../config.js";

/**
 * Framework-agnostic mediasoup SFU service (SPEC.md §11, SFU-lite): one mediasoup
 * {@link types.Worker} child process and a single Opus-only {@link types.Router},
 * plus an in-memory `Map<channelId, VoiceRoom>` registry. Each participant owns a
 * send + recv {@link types.WebRtcTransport}, one audio producer (mic), and a map of
 * consumers (one per remote producer). The server forwards every participant's track
 * to the others — no client mesh.
 *
 * Mirrors {@link ../ws/hub.ts BroadcastHub} / {@link ../ws/presence.ts PresenceRegistry}:
 * a plain class with `#private` fields and no Fastify import, constructed once in
 * `buildApp` and shared with the gateway (story 003). Blessed by the feature for
 * ≤10 clients — one worker, no broker, nothing persisted (voice membership is purely
 * in-memory). The constructor is synchronous and cheap (it only stores config); the
 * worker is created in {@link init} because mediasoup's worker is irreducibly async.
 */

/** Direction of a participant's WebRtcTransport. */
export type TransportDirection = "send" | "recv";

/**
 * Returned by {@link VoiceSfu.createTransport}. The client mediasoup-client `Device`
 * needs these to connect its transport; relayed verbatim by the gateway (story 003).
 */
export interface TransportParams {
  id: string;
  iceParameters: types.IceParameters;
  iceCandidates: types.IceCandidate[];
  dtlsParameters: types.DtlsParameters;
}

/**
 * Returned by {@link VoiceSfu.consume}. The params the client uses to build its
 * receiving consumer; relayed verbatim by the gateway (story 003).
 */
export interface ConsumeParams {
  id: string;
  producerId: string;
  kind: types.MediaKind;
  rtpParameters: types.RtpParameters;
}

/** Per-participant SFU state (internal). Consumers are keyed by remote producer id. */
interface Participant {
  id: string;
  channelId: number;
  sendTransport: types.WebRtcTransport | null;
  recvTransport: types.WebRtcTransport | null;
  producer: types.Producer | null;
  consumers: Map<string, types.Consumer>;
}

/** One voice channel's room (internal). */
interface VoiceRoom {
  channelId: number;
  participants: Map<string, Participant>;
}

/** The single negotiated codec (SPEC.md §11). */
const opusCodec: types.RouterRtpCodecCapability = {
  kind: "audio",
  mimeType: "audio/opus",
  clockRate: 48000,
  channels: 2,
};

export class VoiceSfu {
  readonly #rtcMinPort: number;
  readonly #rtcMaxPort: number;
  readonly #announcedIps: string[];
  readonly #rooms = new Map<number, VoiceRoom>();
  #worker: types.Worker | null = null;
  #router: types.Router | null = null;

  constructor(config: Config) {
    this.#rtcMinPort = config.rtcMinPort;
    this.#rtcMaxPort = config.rtcMaxPort;
    this.#announcedIps = config.rtcAnnouncedIps;
  }

  /**
   * Creates the mediasoup worker (child process bound to the RTC UDP range) and the
   * Opus-only router. Idempotent — returns early if already initialized. Rejects
   * loudly if the RTC port range is unavailable so `buildApp` fails fast at boot.
   */
  async init(): Promise<void> {
    if (this.#worker !== null) return;
    const worker = await createWorker({
      rtcMinPort: this.#rtcMinPort,
      rtcMaxPort: this.#rtcMaxPort,
      logLevel: "warn",
    });
    // Single-worker design (≤10 clients): a worker death is logged and relies on a
    // process restart — no auto-respawn.
    worker.on("died", () => {
      console.error("[voice] mediasoup worker died; restart the server");
    });
    this.#worker = worker;
    this.#router = await worker.createRouter({ mediaCodecs: [opusCodec] });
  }

  /** Router RTP capabilities the client `Device` loads. Throws if not initialized. */
  getRtpCapabilities(): types.RtpCapabilities {
    return this.#requireRouter().rtpCapabilities;
  }

  /**
   * Lazily creates the room + participant on first call, then creates a WebRtcTransport
   * for `direction` (replacing any prior transport for that direction so re-join never
   * leaks). Returns the connect params the client needs.
   */
  async createTransport(
    channelId: number,
    participantId: string,
    direction: TransportDirection,
  ): Promise<TransportParams> {
    const router = this.#requireRouter();
    const participant = this.#getOrCreateParticipant(channelId, participantId);
    const transport = await router.createWebRtcTransport({
      // One listen entry per announced IP: the public IP for remote clients plus any
      // LAN IP (RTC_EXTRA_ANNOUNCED_IPS) so same-network clients avoid NAT hairpin.
      // ICE tries every candidate and keeps whichever pair connects.
      listenIps: this.#announcedIps.map((announcedIp) => ({ ip: "0.0.0.0", announcedIp })),
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });
    if (direction === "send") {
      participant.sendTransport?.close();
      participant.sendTransport = transport;
    } else {
      participant.recvTransport?.close();
      participant.recvTransport = transport;
    }
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  /** Completes DTLS for the participant's transport in `direction` (client→server). */
  async connectTransport(
    channelId: number,
    participantId: string,
    direction: TransportDirection,
    dtlsParameters: types.DtlsParameters,
  ): Promise<void> {
    const participant = this.#requireParticipant(channelId, participantId);
    const transport =
      direction === "send" ? participant.sendTransport : participant.recvTransport;
    if (transport === null) {
      throw new Error(`no ${direction} transport for participant ${participantId}`);
    }
    await transport.connect({ dtlsParameters });
  }

  /**
   * Produces the participant's mic track on its send transport. Closes any pre-existing
   * producer first so re-produce never creates two mic tracks. Returns the producer id.
   */
  async produce(
    channelId: number,
    participantId: string,
    rtpParameters: types.RtpParameters,
  ): Promise<{ producerId: string }> {
    const participant = this.#requireParticipant(channelId, participantId);
    if (participant.sendTransport === null) {
      throw new Error(`no send transport for participant ${participantId}`);
    }
    participant.producer?.close();
    const producer = await participant.sendTransport.produce({
      kind: "audio",
      rtpParameters,
    });
    participant.producer = producer;
    return { producerId: producer.id };
  }

  /**
   * Consumes `producerId` on the participant's recv transport. Returns `null` if the
   * client caps are incompatible (`!router.canConsume`). The consumer is created
   * `paused: true` — the gateway/client resume it via {@link resumeConsumer} once the
   * client side is ready (the canonical mediasoup handshake).
   */
  async consume(
    channelId: number,
    participantId: string,
    producerId: string,
    rtpCapabilities: types.RtpCapabilities,
  ): Promise<ConsumeParams | null> {
    const router = this.#requireRouter();
    const participant = this.#requireParticipant(channelId, participantId);
    if (participant.recvTransport === null) {
      throw new Error(`no recv transport for participant ${participantId}`);
    }
    if (!router.canConsume({ producerId, rtpCapabilities })) {
      return null;
    }
    const consumer = await participant.recvTransport.consume({
      producerId,
      rtpCapabilities,
      paused: true,
    });
    participant.consumers.set(producerId, consumer);
    return {
      id: consumer.id,
      producerId: consumer.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    };
  }

  /** Resumes the participant's consumer of `producerId` (the post-handshake step). */
  async resumeConsumer(
    channelId: number,
    participantId: string,
    producerId: string,
  ): Promise<void> {
    const participant = this.#requireParticipant(channelId, participantId);
    const consumer = participant.consumers.get(producerId);
    if (consumer === undefined) {
      throw new Error(`no consumer of ${producerId} for participant ${participantId}`);
    }
    await consumer.resume();
  }

  /** Pauses the participant's producer (backs mute). No-op if there is no producer. */
  pauseProducer(channelId: number, participantId: string): void {
    const participant = this.#rooms.get(channelId)?.participants.get(participantId);
    void participant?.producer?.pause();
  }

  /** Resumes the participant's producer (backs unmute). No-op if there is no producer. */
  resumeProducer(channelId: number, participantId: string): void {
    const participant = this.#rooms.get(channelId)?.participants.get(participantId);
    void participant?.producer?.resume();
  }

  /**
   * Every participant in the room with a live producer, optionally excluding one (the
   * newcomer self-excluding while consuming existing producers). Empty for an unknown
   * channel.
   */
  listProducers(
    channelId: number,
    exceptParticipantId?: string,
  ): { participantId: string; producerId: string }[] {
    const room = this.#rooms.get(channelId);
    if (room === undefined) return [];
    const out: { participantId: string; producerId: string }[] = [];
    for (const participant of room.participants.values()) {
      if (participant.id === exceptParticipantId) continue;
      if (participant.producer !== null) {
        out.push({ participantId: participant.id, producerId: participant.producer.id });
      }
    }
    return out;
  }

  /**
   * Closes a participant's send + recv transports (cascading to its producer and
   * consumers) and removes it from the room. If the room is now empty it is released,
   * returning `roomEmpty: true` (the transition signal mirroring
   * `PresenceRegistry.remove`'s `lastOffline`). Idempotent for an unknown
   * channel/participant.
   */
  closeParticipant(channelId: number, participantId: string): { roomEmpty: boolean } {
    const room = this.#rooms.get(channelId);
    if (room === undefined) return { roomEmpty: false };
    const participant = room.participants.get(participantId);
    if (participant === undefined) {
      return { roomEmpty: room.participants.size === 0 };
    }
    participant.sendTransport?.close();
    participant.recvTransport?.close();
    room.participants.delete(participantId);
    if (room.participants.size === 0) {
      this.#rooms.delete(channelId);
      return { roomEmpty: true };
    }
    return { roomEmpty: false };
  }

  /**
   * Closes every room's participants, then the router and the worker (the child process
   * exits). Clears all state. Idempotent — safe to call on `onClose` even if `init`
   * never ran.
   */
  async close(): Promise<void> {
    for (const room of this.#rooms.values()) {
      for (const participant of room.participants.values()) {
        participant.sendTransport?.close();
        participant.recvTransport?.close();
      }
    }
    this.#rooms.clear();
    this.#router?.close();
    this.#router = null;
    this.#worker?.close();
    this.#worker = null;
  }

  #requireRouter(): types.Router {
    if (this.#router === null) {
      throw new Error("VoiceSfu not initialized — call init() first");
    }
    return this.#router;
  }

  #requireParticipant(channelId: number, participantId: string): Participant {
    const room = this.#rooms.get(channelId);
    if (room === undefined) {
      throw new Error(`no voice room for channel ${channelId}`);
    }
    const participant = room.participants.get(participantId);
    if (participant === undefined) {
      throw new Error(`no participant ${participantId} in channel ${channelId}`);
    }
    return participant;
  }

  #getOrCreateParticipant(channelId: number, participantId: string): Participant {
    let room = this.#rooms.get(channelId);
    if (room === undefined) {
      room = { channelId, participants: new Map() };
      this.#rooms.set(channelId, room);
    }
    let participant = room.participants.get(participantId);
    if (participant === undefined) {
      participant = {
        id: participantId,
        channelId,
        sendTransport: null,
        recvTransport: null,
        producer: null,
        consumers: new Map(),
      };
      room.participants.set(participantId, participant);
    }
    return participant;
  }
}
