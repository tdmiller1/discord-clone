#plan

# Plan: Client — channel list, selection & create-channel

## Summary
Add a reactive channel list to the existing WS gateway singleton (seeded from `ready.channels`, appended on `channel.create`, deduped by id, filtered to `type === "text"` and sorted by `position`/`id`), a new `channelStore.svelte.ts` runes singleton that owns the active-channel selection (the contract this story `provides`), a typed `channels.ts` REST client for `POST /api/channels` mirroring `auth.ts`, and channel-list + create-channel UI in `Presence.svelte`. Selection state and teardown are wired into the existing logout/session-invalid paths. All decisions in `research.md`'s "Decisions Made" are taken as final — no open questions remained.

## Implementation Steps

### Step 1: Add `PublicChannel`, update `ReadyPayload`, extend `ServerFrame` with `channel.create`
**File(s):** `client/src/lib/types.ts`
**Action:** modify
**Description:** Mirror the story-001/002/003 channel shapes on the client so the gateway and REST client are typed. Replace the M1 `channels: unknown[]` placeholder in `ReadyPayload` with `PublicChannel[]`, add the `PublicChannel` interface (camelCase, epoch-ms `createdAt`), and add the `channel.create` frame to the `ServerFrame` discriminated union.
**Diff shape:**
- Add: `export interface PublicChannel { id: number; name: string; type: "text" | "voice"; position: number; createdBy: number | null; createdAt: number; }`
- Add: `export interface ChannelCreatePayload { channel: PublicChannel; }`
- Change: `ReadyPayload.channels` from `unknown[]` (commented "always [] in M1") to `PublicChannel[]` (update the comment to reference M2/story-002).
- Change: `ServerFrame` union to add `| Envelope<"channel.create", ChannelCreatePayload>`.

### Step 2: Own the reactive channel list on the gateway singleton
**File(s):** `client/src/lib/gateway.svelte.ts`
**Action:** modify
**Description:** Add a `_channels` `$state` Map (keyed by id, mirroring `_members`), a `$derived` getter that filters to `type === "text"` and sorts by `position` then `id`, seed it in the `ready` frame handler, append-deduped in a new `channel.create` handler, expose a `channels` getter, and clear it on `disconnect()`.
**Diff shape:**
- Add: import `PublicChannel` and `ChannelCreatePayload` (via the `ServerFrame`/`types` import already present) — extend the existing `import type { Member, ServerFrame } from "./types"` to include `PublicChannel`.
- Add: `let _channels = $state(new Map<number, PublicChannel>());`
- Add: `const _channelList = $derived([..._channels.values()].filter((c) => c.type === "text").sort((a, b) => a.position - b.position || a.id - b.id));`
- Change: in `handleFrame`'s `ready` case, build a fresh `Map<number, PublicChannel>` from `frame.d.channels` and assign `_channels` (alongside the existing `_members` seed).
- Add: a `case "channel.create":` that does `_channels.set(frame.d.channel.id, frame.d.channel); _channels = new Map(_channels);` (dedupe-by-id is inherent to the Map; reassign for reactivity).
- Add: `get channels(): PublicChannel[] { return _channelList; }` on the exported `gateway` object.
- Change: in `disconnect()`, add `_channels = new Map();` next to the existing `_members = new Map();`.

### Step 3: Create the active-channel selection store
**File(s):** `client/src/lib/channelStore.svelte.ts`
**Action:** create
**Description:** New runes singleton owning only the selected channel id, mirroring `authStore.svelte.ts` (module-level `$state`, getter-only exported object, explicit mutators). Kept separate from the gateway so story 005's message pane imports selection without pulling in WS internals. Exposes `activeId` (getter), `select(id)`, and `clear()`. The channel *object* is resolved by consumers from `gateway.channels` (this store holds only the id, the stable identity).
**Diff shape:**
- Add: `let _activeId = $state<number | null>(null);`
- Add: exported `channelStore` object with `get activeId()`, `select(id: number): void { _activeId = id; }`, and `clear(): void { _activeId = null; }`.
- Add: a file-header doc comment matching the `authStore`/`gateway` style, noting it is the `contracts/client-channel-state.md` deliverable consumed by story 005.

### Step 4: Create the typed `channels.ts` REST client
**File(s):** `client/src/lib/channels.ts`
**Action:** create
**Description:** REST client for `POST /api/channels` mirroring `auth.ts`: discriminated result, `Authorization: Bearer` header, defensive JSON parse, network→result, and a `mapError` mapping the channels-rest-api contract statuses. Success is `201` returning a `PublicChannel`.
**Diff shape:**
- Add: `export type ChannelErrorCode = "channel_name_invalid" | "bad_request" | "unauthorized" | "network" | "unknown";`
- Add: `export type ChannelResult = { ok: true; data: PublicChannel } | { ok: false; error: ChannelErrorCode; status?: number };`
- Add: `mapError(status, bodyError)`: `401 → "unauthorized"`; `400` → `bodyError === "channel_name_invalid" ? "channel_name_invalid" : "bad_request"` (covers the `"Bad Request"` schema-validation body too); else `"unknown"`.
- Add: `createChannel({ serverUrl, token, name })` → POSTs `{ name, type: "text" }` with the Bearer header to `/api/channels`, success on `201`, returning `{ ok: true, data: PublicChannel }`; catches fetch failure → `{ ok: false, error: "network" }`.

### Step 5: Render the channel list, selection, and create-channel control in `Presence.svelte`
**File(s):** `client/src/lib/Presence.svelte`
**Action:** modify
**Description:** Add a Channels section above/alongside Members: a list of `gateway.channels` (text-only via the derived getter), each selectable, with the active one highlighted from `channelStore.activeId`; a default-selection `$effect`; and a create-channel form following the `Login.svelte` pattern (local `$state`, `canSubmit`, `submit` with `preventDefault`, `status: "idle"|"submitting"|"error"`, `messageFor`). On success the new channel arrives via `channel.create`/the 201 (deduped by id) and the input is cleared. Selection routes through `channelStore.select(id)`.
**Diff shape:**
- Add imports: `channelStore` from `./channelStore.svelte`, `createChannel, type ChannelErrorCode` from `./channels`, `store` (already imported) for `serverUrl`/`sessionToken`.
- Add: local form `$state` — `newName`, `createStatus: "idle"|"submitting"|"error"`, `createErr`, and `canCreate = $derived(...)` (non-submitting and `newName.trim() !== ""`).
- Add: a default-selection `$effect` — `if (channelStore.activeId === null && gateway.channels.length > 0) channelStore.select(gateway.channels[0].id);` (re-validate that the active id still exists if a channel set ever shrinks — not needed in M2 since channels are append-only, so a simple null-check suffices).
- Add: `messageFor(code: ChannelErrorCode)` mapping `channel_name_invalid`/`bad_request` → "Enter a valid channel name." style copy, `unauthorized` → session message, `network` → "Could not reach the server.", default → generic.
- Add: `submitCreate(event)` — `preventDefault`, guard `!canCreate`, set `createStatus="submitting"`, call `createChannel({ serverUrl: store.serverUrl, token: store.sessionToken!, name: newName.trim() })`; on `ok` → `channelStore.select(result.data.id)` (so the just-created channel becomes active), clear `newName`, set `createStatus="idle"`; else `createStatus="error"` + `createErr = messageFor(result.error)`.
- Add markup: a `<section class="card">` (or sub-section) with `<h2>Channels</h2>`, a `<ul>` of `{#each gateway.channels as c (c.id)}` rendering a button per channel with `class:active={c.id === channelStore.activeId}` calling `channelStore.select(c.id)`; below it a `<form onsubmit={submitCreate}>` with a name input (`bind:value={newName}`), a submit button disabled when `!canCreate`, and an error line when `createStatus === "error"`. Reuse existing style vars (`--accent` for active, `--muted`, `--ok`, `--text`).
- Add: minimal `<style>` for `.channels` list, `.channel` button, and `.channel.active` (accent highlight), matching the existing Members styling idiom.

### Step 6: Reset selection on logout / session-invalid teardown
**File(s):** `client/src/App.svelte`
**Action:** modify
**Description:** Clear the active-channel selection when the session ends so a re-login starts clean (the gateway already clears its `_channels` in `disconnect()` per Step 2; selection lives in the separate store and must be reset explicitly).
**Diff shape:**
- Add import: `import { channelStore } from "./lib/channelStore.svelte";`
- Change: in `handleLogout()` add `channelStore.clear();` (after `gateway.disconnect()`).
- Change: in `handleSessionInvalid()` add `channelStore.clear();`.

### Step 7: Write the provided contract
**File(s):** `context/features/m2-text-channels/story-004-client-channel-list/contracts/client-channel-state.md`
**Action:** create
**Description:** Document the active-channel selection API (`channelStore`) and the channel shape the message pane (story 005) consumes, so story 005 can build against an authoritative interface. Covers: where the channel **list** lives (`gateway.channels`, text-only, sorted), the `PublicChannel` shape, the selection store surface (`activeId` getter, `select(id)`, `clear()`), how a consumer resolves the active channel object (`gateway.channels.find((c) => c.id === channelStore.activeId)`), default-selection behavior, and teardown semantics.
**Diff shape:**
- Add: a `#contract` markdown file describing the above.

## New Types / Schemas / Contracts

- `PublicChannel` (`client/src/lib/types.ts`) — `{ id: number; name: string; type: "text" | "voice"; position: number; createdBy: number | null; createdAt: number }`. Client mirror of the server/story-003 shape.
- `ChannelCreatePayload` (`client/src/lib/types.ts`) — `{ channel: PublicChannel }`; the `d` of the `channel.create` frame.
- `ServerFrame` gains `Envelope<"channel.create", ChannelCreatePayload>`.
- `ReadyPayload.channels` changes from `unknown[]` to `PublicChannel[]`.
- `ChannelErrorCode` / `ChannelResult` (`client/src/lib/channels.ts`) — discriminated REST result mirroring `AuthErrorCode`/`AuthResult`.
- `channelStore` (`client/src/lib/channelStore.svelte.ts`) — `{ get activeId(): number | null; select(id: number): void; clear(): void }`. The selection contract consumed by story 005.
- `gateway.channels` getter — `PublicChannel[]`, text-only, sorted by `position` then `id`.

## Configuration / Environment Changes

None. No new env vars, config keys, or persisted columns — this is a client-only story; the session token and server URL already live on the `store` singleton.

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| REST client (consumes story-003 `POST /api/channels`) | `createChannel({ serverUrl, token, name })` | `{ name, type: "text" }` JSON body, `Authorization: Bearer <token>` | `{ ok: true; data: PublicChannel }` (201) \| `{ ok: false; error: ChannelErrorCode; status? }` | Maps `400 channel_name_invalid`, `400 Bad Request`, `401 unauthorized`, network → result |
| Selection store (provided) | `channelStore.activeId` / `.select(id)` / `.clear()` | n/a (runes singleton) | `number \| null` / void / void | Documented in `contracts/client-channel-state.md`; consumed by story 005 |
| Reactive list (provided) | `gateway.channels` | n/a | `PublicChannel[]` (text-only, sorted) | Seeded from `ready`, appended on `channel.create`, deduped by id |

## Edge Cases & Gotchas

- **Duplicate `channel.create` (creator's own socket + 201 response).** Map keyed by id makes append idempotent — both reference the same `id`, yielding one entry. Handled in Step 2 (and the create flow in Step 5 relies on it).
- **Voice channels in `ready.channels`/`channel.create`.** M2 never creates voice, but the raw Map may forward-compatibly hold them; the derived `channels` getter filters `type === "text"` so the UI never lists/selects them (AC: voice hidden in M2). Handled in Step 2.
- **Default selection racing the socket.** `ready` may arrive with channels populated, or the list may start empty then grow via `channel.create`; an `$effect` that selects the first channel only when `activeId === null && channels.length > 0` covers both without racing. Handled in Step 5.
- **Empty channel list.** No channels yet → no default selection, list renders empty, create form still usable. Handled in Step 5 (the `$effect` guard and a non-blocking empty list).
- **Svelte 5 Map non-reactivity.** Mutating `_channels` then reassigning `new Map(_channels)` is required to recompute the derived list (same gotcha as `_members`). Handled in Step 2.
- **Selection persisting across logout.** Gateway clears `_channels` on disconnect, but selection lives in the separate store; must call `channelStore.clear()` on logout and session-invalid or a re-login keeps a stale active id. Handled in Step 6.
- **Sort stability.** Sort by `position` then `id` (tiebreak) matches the `ready.channels` server ordering, keeping live-appended channels in a stable place. Handled in Step 2.
- **Missing/empty session token at create time.** The create form is only reachable in the signed-in app view where `store.sessionToken` is non-null; a `401 unauthorized` from the server still maps to a surfaced error (and story 005/App's 4001 path handles a truly dead session). Handled in Steps 4–5.
- **Create error surfacing + input clearing.** `4xx` → `createStatus="error"` + message; input is cleared only on `ok` (matches `Login.svelte`). Handled in Step 5.

## Acceptance Criteria Checklist

- [ ] Renders channel list from `ready.channels`, appends live on `channel.create`, deduped by id → Steps 1, 2, 5
- [ ] Selecting a channel sets shared active-channel runes state (consumed by story 005), visually indicated, with a sensible default selected on first load → Steps 3, 5, 6
- [ ] Create-channel control collects a name, calls `POST /api/channels { name, type: "text" }` with Bearer; on success the channel appears (deduped) and is selectable; `4xx` surfaced; input cleared on success → Steps 4, 5
- [ ] Only `type: "text"` channels listed/selectable; voice hidden → Step 2 (derived filter)
- [ ] `npm run typecheck` passes; verifiable in the running client (create → appears → live on a second client → selectable) → Steps 1–6 (types are exact mirrors of the server contracts)
- [ ] `contracts/client-channel-state.md` documents the active-channel store/selection API and the channel shape story 005 consumes → Step 7
