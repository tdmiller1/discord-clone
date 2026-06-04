#research

# Research: Client — channel list, selection & create-channel

## Files to Touch

### Likely Modified
- `client/src/lib/types.ts` — add `PublicChannel` interface; replace the `channels: unknown[]` placeholder in `ReadyPayload` with `PublicChannel[]`; extend the `ServerFrame` union with the `channel.create` frame (`Envelope<"channel.create", { channel: PublicChannel }>`).
- `client/src/lib/gateway.svelte.ts` — own the reactive channel list. Seed `_channels` from `ready.channels`, append on `channel.create` deduped by `id`, expose a sorted getter (by `position` then `id`). Reset on `disconnect()`. This mirrors how `_members` is seeded/mutated today.
- `client/src/lib/Presence.svelte` — this is the signed-in "app" view (rendered by `App.svelte` for `view === "app"`). Add the channel-list UI region (list + selection highlight + create-channel control) alongside the existing Members section, or extract a child component (see Decisions).
- `client/src/App.svelte` — only if a layout wrapper is introduced; otherwise untouched. Likely minimal/no change since `Presence` is the app shell today.

### Likely Created
- `client/src/lib/channelStore.svelte.ts` — shared active-channel selection state (Svelte 5 runes), the contract this story `provides`. Holds the selected channel id, a `select(id)` mutator, and a `clear()`. Kept separate from the gateway so the message pane (story 005) imports selection without pulling in WS internals (mirrors the `authStore` / `gateway` separation rationale). The channel **list** itself can live on the gateway (it is fed by WS frames) while *selection* lives here.
- `client/src/lib/channels.ts` — typed REST client for `POST /api/channels`, mirroring `auth.ts`: a discriminated `{ ok: true; data: PublicChannel } | { ok: false; error: ... }` result, `Authorization: Bearer` header, defensive JSON parse, network→result. (Could alternatively be folded into an existing module, but a dedicated `channels.ts` matches the `auth.ts` precedent.)
- `client/src/lib/ChannelList.svelte` — optional child component for the list + create control, if `Presence.svelte` gets too large. Follows the `Login.svelte`/`Register.svelte` `$props`/`$state` pattern.
- `client/src/lib/contracts/...` n/a — the deliverable contract file is `contracts/client-channel-state.md` under the story dir (written in the plan/implement phase, per AC).

### Read-Only Reference (patterns to follow)
- `client/src/lib/gateway.svelte.ts` — the canonical reactive-singleton pattern: module-level `$state`, `$derived` sorted list, getters-only exported object, frame handling in a `switch` on `frame.op`, seed-on-`ready` + mutate-on-event, reassign Maps to trigger reactivity. Copy this for channels.
- `client/src/lib/auth.ts` — REST client shape: `post()` helper, `Bearer` header, `mapError(status, body.error)`, discriminated `AuthResult`. Copy for `channels.ts`.
- `client/src/lib/Login.svelte` — form/`$state`/`canSubmit`/`status: "idle"|"submitting"|"error"`/`messageFor(code)` pattern for the create-channel input and error surfacing; clear input on success.
- `client/src/lib/authStore.svelte.ts` — getter-only reactive singleton with explicit mutators; template for `channelStore.svelte.ts`.
- `client/src/lib/Presence.svelte` — the current app view; styling vars (`--ok`, `--muted`, `--accent`, `--text`), `{#each ... (key)}`, `$derived` usage, and where `store.currentUser` / `gateway.members` are read.

## Existing Patterns

**Reactive singletons in `*.svelte.ts`.** Both `authStore.svelte.ts` and `gateway.svelte.ts` declare module-level `let _x = $state(...)`, optionally a `$derived` list, and export a plain object with `get x()` accessors plus mutator methods. This keeps state alive across component re-renders with one teardown point. New shared state (channel list, active selection) must follow this exactly — read fields directly off the singleton (e.g. `gateway.channels`, `channelStore.activeId`).

**Gateway frame handling.** `handleFrame(frame)` switches on `frame.op`. `ready` builds a fresh `Map`, assigns, sets `_status = "open"`, resets backoff. `presence.update` mutates then **reassigns** the Map (`_members = new Map(_members)`) because Svelte 5 Maps aren't deeply reactive. Unknown ops fall through `default` and are ignored. For channels: handle `ready` (seed `_channels`) and add a `channel.create` case (append + dedupe by `id`). An array works fine for channels (reassign on append for reactivity); a `Map<number, PublicChannel>` keyed by id makes dedupe trivial and matches the members approach.

**Sorted derived list.** `_memberList = $derived([..._members.values()].sort(...))`. Channels sort by `position` then `id` (per the `ready.channels` contract ordering). Filter to `type === "text"` in the derived getter so voice channels are excluded from the M2 list (AC: voice hidden in M2).

**REST client.** `auth.ts` is non-runes, bundler imports (no `.js` suffix on client — that ESM `.js` rule is server-only). `post(serverUrl, path, okStatus, body?, token?)` returns a discriminated result; `mapError` maps status+`body.error` to a code; screens call `messageFor(code)`. `channels.ts` should expose `createChannel({ serverUrl, token, name })` → `{ ok: true; data: PublicChannel } | { ok: false; error }`. Map `400 channel_name_invalid` / `400 Bad Request` / `401 unauthorized` per the channels-rest-api contract.

**Session token + server URL.** Both come from the `store` singleton: `store.sessionToken` (Bearer) and `store.serverUrl` (base for `new URL(path, serverUrl)`). No keychain access needed in this story — the token is already in the store post-login.

**Forms.** `Login.svelte`: `$props` for callbacks, local `$state` for fields, `canSubmit` `$derived`, `submit(event)` does `event.preventDefault()`, guards `!canSubmit`, sets `status="submitting"`, awaits the REST call, on `ok` runs success path, else `status="error"` + `errorMsg`. The create-channel control follows this; on success clear the name input (the new channel arrives via `channel.create` and/or the 201 response, deduped by `id`).

## Data Flow

1. **Initial list.** `Presence.svelte` mounts → `gateway.connect()` → socket opens → `identify` → server sends `ready` with `channels: PublicChannel[]` (story 002 changed this from `[]`). `handleFrame`'s `ready` case seeds `_channels`. The derived getter filters `type==="text"`, sorts by `position`/`id`. UI renders the list.
2. **Default selection.** On first load, when `gateway.channels` is non-empty and `channelStore.activeId` is null, select a sensible default (first text channel by sort order). Implemented via an `$effect` in the view (or a helper on the store) so it reacts once channels arrive.
3. **Create.** User types a name → submits → `channels.createChannel({ serverUrl, token, name })` POSTs `{ name, type: "text" }` with Bearer. Server returns `201 PublicChannel` **and** broadcasts `channel.create` to all sockets (including this one). The gateway's `channel.create` handler appends deduped by `id`; the response is redundant but can also be merged (dedupe by `id` guarantees one entry). Clear the input on success; surface `4xx` via `messageFor`.
4. **Live append (other clients).** A second client creating a channel triggers `channel.create` on this socket → gateway appends → list updates reactively. No REST involved here.
5. **Selection → message pane (story 005).** Selecting a channel calls `channelStore.select(id)`; the message pane reads `channelStore.activeId` (and resolves the channel object from `gateway.channels`) to fetch/render history. That consumer is story 005; this story only provides the state.
6. **Teardown.** `gateway.disconnect()` (logout/unmount) clears `_members` today; add clearing `_channels`. `channelStore.clear()` should reset selection on logout (wire into `App.handleLogout`/`handleSessionInvalid` or the gateway teardown).

## Decisions Made

1. **Channel list lives on the gateway singleton; selection lives in a new `channelStore`.** The list is fed by WS frames (`ready`, `channel.create`), so it belongs next to the other WS-derived state (`_members`). Selection is cross-cutting view state consumed by story 005's message pane, so it gets its own store — mirroring the deliberate `authStore`/`gateway` split. This satisfies `provides_contract: contracts/client-channel-state.md` cleanly (the store is the documented selection API).
2. **Dedupe by `id` using a Map (or an array with an id check).** The `channel.create` broadcast reaches the creator too, and the 201 response duplicates it, so dedupe is mandatory. Keying `_channels` as `Map<number, PublicChannel>` (like `_members`) makes this trivial and matches the existing pattern; reassign the Map on mutation for reactivity.
3. **Filter `type === "text"` in the derived getter.** AC requires voice channels hidden/disabled in M2. Filtering in the sorted derived getter keeps the raw map intact (forward-compatible with M4) while the UI only ever sees text channels.
4. **Dedicated `channels.ts` REST module** mirroring `auth.ts`, rather than extending `auth.ts`. Keeps the auth module focused and matches the one-module-per-domain precedent; reuses the same result/`mapError` shape.
5. **Default-channel selection via `$effect` reacting to `gateway.channels`.** Channels arrive asynchronously after `ready`; an effect that selects the first text channel when none is active handles both the populated-`ready` and empty-then-`channel.create` cases without racing the socket.
6. **Render inside `Presence.svelte` (optionally extracting `ChannelList.svelte`).** `Presence` is already the app shell; adding the channel column there is the smallest change. Extract a child only if the file grows unwieldy — both follow the same runes/`$props` conventions.
7. **No `.js` import suffix on client imports.** That NodeNext rule is server-only; client uses the Vite bundler (confirmed by `auth.ts` importing `./types` with no suffix).
