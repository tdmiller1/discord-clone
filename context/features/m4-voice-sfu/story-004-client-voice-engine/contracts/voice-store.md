#contract

# Contract: Reactive voice store (M4 story 004)

Authoritative public API of the client voice engine, exported from
`client/src/lib/voice.svelte.ts` as the singleton `voice`. **Story 005 (the voice UI) consumes
exactly this** — it imports `voice` and binds its reactive getters / calls its actions; it never
touches mediasoup-client, the gateway socket, or any `<audio>` element (the store owns playback,
capture, and teardown).

The store is a Svelte 5 runes module singleton (mirrors `gateway.svelte.ts`): the getters below
read `$state`, so reading them inside a component's markup or `$derived`/`$effect` is reactive.
All voice signaling rides the existing `/ws` gateway socket via `gateway.sendVoice` /
`gateway.onVoiceFrame` — there is no second WebSocket.

```ts
import { voice } from "./lib/voice.svelte";
```

---

## Types

```ts
/** Lifecycle of the local voice session. */
type VoiceStatus = "idle" | "joining" | "connected" | "error";

/** A remote peer in the current call (self is never in this list). */
interface VoiceParticipant {
  participantId: string;   // SFU participant id (stable per peer socket)
  userId: number | null;   // resolved once a voice.state for this peer arrives; null until then
  muted: boolean;          // peer's outbound mute (from their voice.state)
  deafened: boolean;       // peer's deafen flag (UI-only; from their voice.state)
}
```

## Reactive state (getters)

| Getter | Type | Meaning |
|---|---|---|
| `voice.status` | `VoiceStatus` | `idle` (not in voice), `joining` (capturing mic + negotiating), `connected` (in the call, audio flowing), `error` (a transport went `failed`/`disconnected`; the session is being/was torn down — pair with `voice.error`). |
| `voice.voiceChannelId` | `number \| null` | The channel id the local user is joined to, or `null` when not in voice. Set when `voice.joined` arrives, cleared on `leave()`/`teardown()`. |
| `voice.participants` | `VoiceParticipant[]` | Remote peers currently in the call (excludes self). Grows on `voice.joined.producers` / `voice.new_producer`, shrinks on `voice.peer_left`; each entry's `muted`/`deafened`/`userId` update on that peer's `voice.state`. Reassigned on every change (safe to use in `$derived`). |
| `voice.muted` | `boolean` | Local outbound mute. `true` ⇒ the local producer is paused (peers receive no audio). Toggled by `toggleMute()`. |
| `voice.deafened` | `boolean` | Local inbound playback mute. `true` ⇒ every remote `<audio>` is muted locally (server media unaffected). Toggled by `toggleDeafen()`. |
| `voice.error` | `string \| null` | Last error message: mic permission denied/unavailable, not connected, transport `failed`/`disconnected`, a server `voice.error`, or a negotiation failure. `null` while healthy. Cleared at the start of the next `join()`. |

`status` and `error` together describe failures: on mic denial `status` returns to `idle` with a
non-null `error` (no half-join); on a transport failure `status` becomes `error` with a non-null
`error`. The UI should surface `error` whenever it is non-null.

## Actions

```ts
/** Capture the mic (getUserMedia({audio:true})) and run the full SFU negotiation: voice.join →
 * Device.load(routerRtpCapabilities) → send+recv transports → produce the Opus mic track →
 * consume every existing producer. Resolves when negotiation settles (status `connected`) or
 * after an error has been recorded.
 *
 * NEVER throws / rejects — all failures are surfaced via `error` + `status`:
 *   - mic permission denied / no input device  → `error` set, `status` back to `idle`, NO
 *     `voice.join` sent (presence stays out of voice; no half-join).
 *   - socket not open                          → `error` "not connected", `status` `idle`.
 *   - server voice.error / negotiation failure → `error` set, `status` `error`, full teardown.
 * Idempotent: calling join() while already connected tears the current call down first, so a
 * second join never produces two mic tracks. */
join(channelId: number): Promise<void>;

/** Leave the call: sends voice.leave, closes the producer / all consumers / both transports,
 * stops the mic tracks (mic indicator off), removes every remote <audio>, and resets all
 * reactive state (status `idle`, voiceChannelId `null`, participants `[]`, muted/deafened
 * `false`). Safe to call when not in a call (no-op). */
leave(): void;

/** Toggle local outbound mute: flips `muted`, pauses/resumes the local producer, and relays
 * voice.state {muted, deafened} to peers. Convergent under rapid toggles (state set to the
 * final value before the producer call + send). No-op-safe before a producer exists. */
toggleMute(): void;

/** Toggle local inbound playback (deafen): flips `deafened`, mutes/unmutes every remote
 * <audio> element locally, and relays voice.state {muted, deafened} for peer UI. Server media
 * is unaffected. */
toggleDeafen(): void;

/** Socket-gone teardown: same cleanup as leave() but WITHOUT sending voice.leave (the socket is
 * already closed). The gateway invokes this automatically on disconnect()/4001; the UI rarely
 * needs it directly. Idempotent. */
teardown(): void;
```

## Lifecycle guarantees

- **One teardown point.** `leave()` and `teardown()` route through a single internal teardown
  that closes the producer/consumers/transports, stops the mic, drops all `<audio>`, and resets
  state. No dangling `MediaStream`s or transports after either.
- **Auto-teardown on socket loss.** The store registers `gateway.onVoiceTeardown` at module
  load, so an intentional `gateway.disconnect()` (logout/unmount) and a 4001 auth-fail both tear
  voice down cleanly — the UI does not have to coordinate this.
- **Bidirectional audio is automatic.** Existing peers are consumed from `voice.joined.producers`
  on join; peers that join mid-call are consumed from `voice.new_producer`. The UI only renders
  `participants`; it does not drive consume/produce.

## Presence (related, owned by the gateway)

`voice.participants` is the SFU-level truth for the **local** call. The broader "who's in voice"
indicator across all members is driven by `gateway.members[].voiceChannelId` (the gateway now
threads `voiceChannelId` through `presence.update` and seeds it from the `ready` snapshot).
Story 005 reads the gateway member list for per-user voice presence and the `voice` store for
the local call roster + controls.
