#plan

# Plan: Client — voice channel UI, join/leave, mute & in-voice presence

## Summary
Surface the seeded voice channel to the client UI as a parallel, non-message-pane control: add a text-safe `voiceChannels` getter on the gateway, render a dedicated `VoicePanel.svelte` (Join/Leave, in-call roster, mute/deafen, error) wired to the story-004 `voice` store, and add a per-member "in voice" indicator to the existing members list driven by `gateway.members[].voiceChannelId`. Text-channel selection and the message pane are left untouched.

## Implementation Steps

### Step 1: Expose voice channels from the gateway without disturbing text consumers
**File(s):** `client/src/lib/gateway.svelte.ts`
**Action:** modify
**Description:** Keep `_channelList` / `gateway.channels` text-only (so `MessagePane.find` and `Presence`'s default-select `$effect` stay correct), and add a parallel `voiceChannels` getter so the seeded `type:"voice"` channel reaches the UI. This is research Decision 2 option (a) — the lowest-risk path; text consumers and default-select stay unchanged, and the AC's `type === "text"` filter is addressed by adding the parallel voice surface rather than un-filtering. (`_channels`/`presence.update`/`ready` already thread `voiceChannelId`, lines 99–110 — no presence change needed.)
**Diff shape:**
- Add a `_voiceChannelList` `$derived` next to `_channelList` (line ~46): `[..._channels.values()].filter((c) => c.type === "voice").sort((a, b) => a.position - b.position || a.id - b.id)`.
- Add a `get voiceChannels(): PublicChannel[]` getter to the exported `gateway` object (next to `channels`, ~line 208) returning `_voiceChannelList`, with a doc comment mirroring the `channels` getter.
- Change: none to `_channelList`, the default-select effect, or `MessagePane` — they stay text-only by construction.

### Step 2: Create the VoicePanel component (Join/Leave + roster + mute/deafen + error)
**File(s):** `client/src/lib/VoicePanel.svelte`
**Action:** create
**Description:** A runes-singleton-consuming component (mirrors `MessagePane.svelte`) that renders the single voice channel block and binds the `voice` store reactively. Imports `voice` from `./voice.svelte` and `gateway` from `./gateway.svelte`; reads `gateway.voiceChannels[0]` as the room. Renders the channel name with a distinct speaker glyph (not a `#` hash, and NOT a `channelStore.select` button — it is never a message-pane target). Shows a **Join** button (calls `voice.join(channel.id)`) when not in voice, and a **Leave** button (calls `voice.leave()`) when in voice. While in voice it also shows **Mute/Unmute** (`voice.toggleMute()`, label/active from `voice.muted`) and **Deafen/Undeafen** (`voice.toggleDeafen()`, from `voice.deafened`). Renders the in-call roster from `voice.participants` plus the local user, and surfaces `voice.error` when non-null. Styling reuses `Presence.svelte`'s `.channel` / `.member` / `.dot` conventions and the `--accent`/`--muted`/`--ok`/`--text`/`--err` CSS vars.
**Diff shape:**
- Add `<script lang="ts">`: import `voice`, `gateway`, and `store` (for `selfId`/self username); `const channel = $derived(gateway.voiceChannels[0] ?? null)`; `const inVoice = $derived(voice.voiceChannelId !== null)`; `const joining = $derived(voice.status === "joining")`; `const selfId = $derived(store.currentUser?.id ?? null)`.
- Add markup: a `.voice-card` section, hidden entirely when `channel === null` (no voice channel seeded); the channel header row with a speaker glyph + name; a Join button (`disabled={joining}`, shows "Joining…" while `joining`) shown when `!inVoice`, else a Leave button; when `inVoice`, a Mute toggle (`class:active={voice.muted}`) and a Deafen toggle (`class:active={voice.deafened}`); an in-call roster `<ul>` listing the local user ("(you)" + muted marker from `voice.muted`) and `{#each voice.participants as p (p.participantId)}` (label = resolved member username via `gateway.members` by `p.userId`, fallback to `p.participantId`; muted marker from `p.muted`); a `{#if voice.error}` `.err` line.
- Add `<style>`: `.voice-card`, `.voice-channel` (distinct glyph), `.controls` button row, `.in-voice` roster reusing `.member`/`.dot`/`.muted-marker`, `.err` — borrowing the existing CSS-var palette.

### Step 3: Host VoicePanel in the app shell and guard the default-select path
**File(s):** `client/src/lib/Presence.svelte`
**Action:** modify
**Description:** Import and mount `VoicePanel` as a parallel section (its own `.card`, e.g. directly under the Channels card or beside Members), so the voice control sits next to — never inside — the text-channel list / message pane. The default-select `$effect` (lines 23–27) and the channel `{#each}` (lines 101–112) already iterate `gateway.channels`, which Step 1 keeps text-only, so no voice channel can ever be passed to `channelStore.select` or rendered as a message pane — no change needed there beyond confirming. This satisfies "voice is a parallel control, not a message view."
**Diff shape:**
- Add `import VoicePanel from "./VoicePanel.svelte";` to the script imports.
- Add `<section class="card"><VoicePanel /></section>` in the template (a sibling of the Channels and Members cards).
- Change: none to the default-select `$effect` or channel loop (they remain text-only via Step 1).

### Step 4: Per-member voice indicator in the existing members list
**File(s):** `client/src/lib/Presence.svelte`
**Action:** modify
**Description:** In the existing `{#each gateway.members as m (m.id)}` loop (lines 135–143), show a voice marker when `m.voiceChannelId !== null`. This covers ALL members (including remote peers whose `userId` may not yet be resolved in `voice.participants`) and is driven by the gateway member list per research Decision 3 — the in-call roster (Step 2) uses `voice.participants`, the member indicator uses `gateway.members[].voiceChannelId`.
**Diff shape:**
- Add an inline marker inside the `<li class="member">` (e.g. `{#if m.voiceChannelId !== null}<span class="voice-marker" title="In voice">🔊</span>{/if}`) after the `.name` span.
- Add a `.voice-marker` style (small, `color: var(--ok)`), reusing the palette.

## New Types / Schemas / Contracts
- No new TS types. `VoicePanel.svelte` declares no props (it reads the `voice` + `gateway` singletons directly, mirroring `MessagePane.svelte`).
- **This story declares NO downstream contract** (`provides_contract:` is empty in the story frontmatter) — nothing here is consumed by a later story.

## Configuration / Environment Changes
None. No new deps, env vars, or config — the voice engine (story 004) and `voiceChannelId` plumbing already exist; this is presentation + wiring only.

## API / Interface Changes
| Surface | Identifier | Request / Input | Response / Output | Notes |
|---|---|---|---|---|
| Gateway singleton getter | `gateway.voiceChannels` | (none) | `PublicChannel[]` | New. Voice channels sorted by position then id; parallel to `gateway.channels` (which stays text-only). Read directly in markup/`$derived`. |
| Svelte component | `VoicePanel.svelte` | no props | rendered voice block | New. Consumes `voice` + `gateway` singletons; Join/Leave/Mute/Deafen + in-call roster + error. Never routes through `channelStore`. |
| Svelte component | `Presence.svelte` | existing props (`onLogout`, `onSessionInvalid`) | unchanged | Hosts `<VoicePanel />` and adds a per-member voice marker. |

## Edge Cases & Gotchas
- **Voice channel must NOT enter text-channel selection / message-pane path** (the research gotcha) → Step 1 keeps `gateway.channels`/`_channelList` and the default-select `$effect` text-only and adds a separate `voiceChannels` getter; Step 2 renders the voice channel via Join/Leave, never `channelStore.select`. `MessagePane.find(... activeId)` therefore can never resolve a voice channel. (Steps 1–3)
- **Join error (mic denied / connect failed)** surfaced via `voice.error` (non-null) → Step 2 renders a `{#if voice.error}` line; store guarantees `status` returns to `idle` (mic denial) or `error` (transport) with `error` set — UI surfaces it whenever non-null. (Step 2)
- **Join→Leave button state** from voice lifecycle → Step 2 derives `inVoice = voice.voiceChannelId !== null`; Join shown when `!inVoice`, Leave when `inVoice`; Join disabled + "Joining…" while `voice.status === "joining"`. (Step 2)
- **In-voice roster** from `voice.participants` (reassigned on every change → safe in `$derived`) plus the local user → Step 2 roster. (Step 2)
- **Mute/deafen reflect & drive** `voice.muted` / `voice.deafened` → Step 2 toggle buttons (`class:active`) calling `voice.toggleMute()` / `voice.toggleDeafen()`. (Step 2)
- **Per-member voice indicator** from `members[].voiceChannelId` (covers everyone, resolves userId; broader than the local call) → Step 4. (Step 4)
- **No voice channel seeded** (defensive) → `gateway.voiceChannels[0] ?? null`; `VoicePanel` renders nothing when null. (Steps 1–2)
- **Resolving a participant's username** before `voice.state` arrives: `p.userId` may be `null` → roster falls back to `p.participantId`; look up username via `gateway.members` by `p.userId` when present. (Step 2)
- **Text-channel selection + message pane unaffected** → no change to `channelStore`, `MessagePane`, the default-select `$effect`, or the channel `{#each}`. (Step 3)
- **Teardown is already owned** by the gateway/voice seam (`onVoiceTeardown` on disconnect/4001) — `Presence`/`VoicePanel` need no extra teardown wiring (contract "Auto-teardown on socket loss").

## Acceptance Criteria Checklist
- [ ] Voice channel is rendered in the channel list, visually distinct, not selectable as a message pane (extends the `type === "text"` filter) → Steps 1, 2, 3
- [ ] Join control calls `voice.join()`; becomes Leave (`voice.leave()`) while in voice; surfaces a clear error on mic-deny / connect-fail → Step 2
- [ ] In-voice participant list shows who is in the voice channel, updating live → Step 2 (`voice.participants`) + Step 4 (`members[].voiceChannelId`)
- [ ] Mute toggle reflects and drives the engine's `muted` state; own muted state visible (+ optional deafen) → Step 2
- [ ] Member-list voice indicator driven by `voiceChannelId` → Step 4
- [ ] Switching text channels + message pane still works (voice is parallel) → Steps 1, 3 (text path untouched)
- [ ] `npm run typecheck` (incl. `svelte-check`) passes; two clients show the voice channel and each other in-voice with mute reflected → all steps; verified manually per the feature's two-client acceptance
