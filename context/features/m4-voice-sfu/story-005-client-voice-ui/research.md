#research

# Research: Client — voice channel UI, join/leave, mute & in-voice presence

## Files to Touch

### Likely Modified
- `client/src/lib/gateway.svelte.ts` — the `_channelList` derived (lines 41–46) currently `.filter((c) => c.type === "text")`, dropping the seeded voice channel entirely. Must stop filtering voice out so the voice channel reaches the UI. Two safe options: (a) drop the filter and expose all channels (sorted), letting the UI branch on `c.type`; or (b) keep `channels` text-only and add a parallel `voiceChannels` getter. Either way the voice channel must become readable. The `members`/`presence.update`/`ready` plumbing already threads `voiceChannelId` (lines 99–110, 27) — no gateway change needed for presence.
- `client/src/lib/Presence.svelte` — this is the main app shell (channel list + members list + message pane host, despite the name). Add: (1) a Voice section/control rendering the voice channel with a Join/Leave button wired to `voice.join(id)` / `voice.leave()`, the in-voice participant list, and a mute (+ optional deafen) toggle reading/driving `voice.muted`/`voice.deafened`; (2) a per-member voice indicator in the existing members `{#each gateway.members}` loop driven by `m.voiceChannelId`. Surface `voice.error` when non-null. Must also guard the default-select `$effect` (lines 23–27) and the channel `{#each}` so a voice channel is never passed to `channelStore.select` / rendered as a message pane.
- `client/src/App.svelte` — already imports `voice` and calls `voice.leave()`/`voice.teardown()` in logout/session-invalid; no change strictly required, but confirm no extra wiring is needed (it is the natural owner if any top-level voice teardown coordination is added — currently handled by the gateway seam).

### Likely Created
- (Optional) `client/src/lib/VoicePanel.svelte` — a dedicated component for the voice channel block (Join/Leave + participant roster + mute/deafen + error), imported by `Presence.svelte`. Keeps `Presence.svelte` from ballooning and mirrors the existing `MessagePane.svelte` extraction pattern. Decision deferred to plan; the logic could also live inline in `Presence.svelte`.

### Read-Only Reference (patterns to follow)
- `client/src/lib/voice.svelte.ts` — the story-004 engine. Public surface (`export const voice`, line 434) matches `contracts/voice-store.md` exactly: getters `status`/`voiceChannelId`/`participants`/`muted`/`deafened`/`error`, actions `join(channelId)`/`leave()`/`toggleMute()`/`toggleDeafen()`/`teardown()`. Consume ONLY these — never the mediasoup/socket internals.
- `client/src/lib/MessagePane.svelte` — pattern for a runes-singleton-consuming component; resolves the active channel via `gateway.channels.find((c) => c.id === channelStore.activeId)` (line 26). This is exactly why voice channels must NOT enter `channelStore` selection (see Data Flow).
- `client/src/lib/channelStore.svelte.ts` — the reactive selection singleton; `select(id)`/`activeId`/`clear()`. Voice is a *parallel* control and must not flow through this.
- `client/src/lib/Presence.svelte` styling — CSS conventions: `.channel`/`.channel.active`, `.member`/`.dot.online`/`.dot.offline`, CSS vars `--accent`/`--muted`/`--ok`/`--text`/`--err`. Borrow these for the voice block + indicator.

## Existing Patterns

- **Runes-module singletons read directly in markup.** Components import the singleton (`import { voice } from "./voice.svelte"`, `import { gateway } from "./gateway.svelte"`) and read getters straight in markup / `$derived` / `$effect`; the getters wrap `$state`, so reads are reactive (no stores, no `export let`). E.g. `Presence.svelte` does `{#each gateway.members as m (m.id)}` and `{#each gateway.channels as c (c.id)}`.
- **Channel list render + select.** `Presence.svelte` lines 100–113: each channel is a `<button class="channel" class:active={c.id === channelStore.activeId} onclick={() => channelStore.select(c.id)}>` with a `#` hash span. The voice channel needs a visually distinct, non-message-selectable variant (different glyph/icon, its own Join/Leave button rather than a select-channel button).
- **Default selection effect.** Lines 23–27: `$effect` selects `gateway.channels[0]` when nothing is active. If voice channels enter `gateway.channels`, this could select a voice channel as the message pane — must filter to text channels here (or keep `gateway.channels` text-only and add a separate voice accessor).
- **Members list render.** Lines 134–144: `{#each gateway.members as m}` with an online/offline `.dot` and a `.name` (`(you)` suffix for self via `selfId`). The voice indicator hangs off this same loop, conditioned on `m.voiceChannelId !== null`.
- **Self id.** `const selfId = $derived(store.currentUser?.id ?? null)` (line 77) — reuse to mark the local user in the in-voice list.
- **Styling.** Plain `<style>` block, CSS custom properties (`--muted`, `--ok`, `--accent`, `--text`, `--err`), small uppercase `h2` section headers, `.card` sections in `App.svelte`'s layout.

## Data Flow

**Render the voice channel:** server seeds one `type:"voice"` channel (story 001) → arrives in `ready.channels` / `channel.create` → `gateway._channels` map → (currently filtered out by `_channelList`'s `type === "text"`). Fix: surface voice channels to the UI → render them in a distinct Voice block in `Presence.svelte`, NOT as a `channelStore.select` target.

**Join → connected:** user clicks Join on the voice channel → `voice.join(channel.id)` (story-004 engine; never throws) → engine captures mic + negotiates SFU over `/ws` → `voice.status` goes `joining` → `connected`, `voice.voiceChannelId` set, `voice.participants` populated from existing producers. UI reads these reactively: Join becomes **Leave** when `voice.voiceChannelId !== null` (or `status === "connected"/"joining"`), and renders the in-call roster.

**Mute/deafen:** mute button calls `voice.toggleMute()` → flips `voice.muted`, pauses producer, relays `voice.state`; UI shows own muted state from `voice.muted`. Optional deafen via `voice.toggleDeafen()` ↔ `voice.deafened`.

**Errors:** mic-denied → `voice.status` back to `idle` + `voice.error` non-null (no half-join). Transport failure → `voice.status === "error"` + `voice.error`. UI surfaces `voice.error` whenever non-null.

**Leave:** Leave button → `voice.leave()` → engine tears down, resets `status` `idle`, `voiceChannelId` `null`, `participants` `[]`, `muted`/`deafened` `false`.

**Per-member voice indicator (broader than the local call):** any user's voice membership rides `presence.update.voiceChannelId` (and the `ready` snapshot seed) → `gateway._members[].voiceChannelId` (gateway already threads it, lines 27 & 105) → `gateway.members` → in the `Presence.svelte` members loop, show a voice marker when `m.voiceChannelId !== null`. This covers all members (including remote peers whose `userId` may not yet be resolved in `voice.participants`), which is why the member indicator uses the gateway member list, while the in-call roster uses `voice.participants` per the contract's "Presence" note.

**Two-client acceptance:** client A joins → A's `voice.voiceChannelId` set, presence.update broadcasts A's `voiceChannelId` → both clients mark A in voice. B joins → both see each other in the in-voice list; B's `voice.participants` gains A and vice versa; mute toggled on one reflects via `voice.state` → peer's `VoiceParticipant.muted`.

## Decisions Made

1. **Voice channel is rendered as a non-selectable, distinct block — not a `channelStore` target.** `MessagePane.svelte` resolves its channel via `gateway.channels.find(... activeId)`; routing a voice channel through `channelStore.select` would make the message pane try to render a voice channel. So the voice channel gets its own control (Join/Leave button + roster), and text-channel selection / message-pane behavior (M2) is untouched. This directly satisfies the AC "voice is a parallel control, not a message view."
2. **Surface voice channels without breaking the text-only assumptions.** Prefer keeping `gateway.channels` semantics safe for `MessagePane`/default-select by either (a) adding a separate `voiceChannels` getter on the gateway (cleanest — text consumers stay unchanged, default-select stays `gateway.channels[0]`), or (b) un-filtering `_channelList` and guarding both the default-select `$effect` and the `MessagePane.find` to text-only. Plan to pick one; option (a) is lower-risk. Either way the `_channelList` `type === "text"` filter described in the AC is addressed.
3. **Two presence sources, by design.** Per-member "who's in voice" indicator reads `gateway.members[].voiceChannelId` (covers everyone, resolves `userId`); the in-call roster + controls read the `voice` store. This matches the contract's "Presence" section verbatim.
4. **Consume the voice store only via its documented surface.** No `<audio>`, no mediasoup, no second socket in this story — the engine owns playback/capture/teardown.
