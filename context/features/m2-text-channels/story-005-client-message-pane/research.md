#research

# Research: Client — message history, composer & live updates

## Files to Touch

### Likely Modified
- `client/src/lib/gateway.svelte.ts` — own the reactive message state and the `message.create` handler, and expose a public `sendMessage(channelId, content)` (the `socket` is currently a module-private local with no public send). The gateway already owns the WS lifecycle and `ready`/`channel.create`/`presence.update` handling, so messages belong here alongside `channels`/`members` rather than in a new socket-touching module. Add: a `Map<channelId, Map<messageId, PublicMessage>>` (or per-channel array deduped by id), a `messagesFor(channelId)` getter, a `prependHistory(channelId, msgs[])` method (for history + load-older), and a `case "message.create"` branch that upserts by `message.id`. Clear message state in `disconnect()` (mirrors `_channels`/`_members` reset).
- `client/src/lib/types.ts` — add the client `PublicMessage` interface (mirror of story-003 shape), `MessageCreatePayload`, and extend the `ServerFrame` discriminated union with `Envelope<"message.create", MessageCreatePayload>` (currently only `ready` / `presence.update` / `channel.create`).
- `client/src/lib/Presence.svelte` — host the new `MessagePane` next to the existing channel list / members sections (this is the single signed-in screen). Pass the active channel through, or simply mount `<MessagePane />` which reads `channelStore`/`gateway` itself. Minor layout/CSS.

### Likely Created
- `client/src/lib/messages.ts` — typed REST client for `GET /api/channels/:id/messages` (mirrors `channels.ts` / `auth.ts`: URL building, `Authorization: Bearer`, discriminated `{ ok, data | error }` result, defensive JSON parse, network→result). Function `fetchMessages({ serverUrl, token, channelId, before?, limit? })` returning `PublicMessage[]` newest-first; map 404→`channel_not_found`, 401→`unauthorized`, etc.
- `client/src/lib/MessagePane.svelte` — the pane component: an `$effect` keyed on `channelStore.activeId` that fetches the latest page and seeds `gateway` history; renders `gateway.messagesFor(activeId)` oldest→newest resolving author names from the `members` map; a "load older" affordance using the `before` cursor; the empty/placeholder state when `activeChannel` is `null`.
- `client/src/lib/Composer.svelte` — (optional split; could live inside `MessagePane.svelte`) the input + send button. Calls `gateway.sendMessage(activeId, content.trim())`, clears input on send, disables/prevents empty-whitespace or over-max content. Mirrors the create-channel `<form onsubmit>` pattern already in `Presence.svelte`.

### Read-Only Reference (patterns to follow)
- `client/src/lib/channels.ts` — the REST-client shape to copy for `messages.ts` (discriminated result, `mapError`, defensive parse).
- `client/src/lib/gateway.svelte.ts` — runes-in-`.svelte.ts` singleton; how `ready`/`channel.create` seed/append `Map` state and reassign the Map to recompute `$derived` lists; the `disconnect()` reset.
- `client/src/lib/channelStore.svelte.ts` + `contracts/client-channel-state.md` — `channelStore.activeId` is the fetch/send key; resolve the channel object via `gateway.channels.find(c => c.id === activeId)`.
- `client/src/lib/Presence.svelte` — the create-channel `<form onsubmit={...}>` + `$derived` `canCreate` guard is the exact composer pattern; the `{#each ... (key)}` keyed-list and `$effect` for default selection.

## Existing Patterns

- **Reactive singletons in `*.svelte.ts`**: module-level `let _x = $state(...)`, `$derived` for sorted/filtered views, exported plain object with getters + mutator methods (`gateway`, `channelStore`, `store`). No classes.
- **Svelte 5 Maps aren't deeply reactive** — `gateway.handleFrame` reassigns (`_channels = new Map(_channels)`) after a `.set()` so `$derived` lists recompute. Message state must do the same.
- **Frame handling**: `handleFrame(frame)` switch on `frame.op`; unknown ops fall through to `default: break`. Add `case "message.create"`.
- **REST clients** (`auth.ts`, `channels.ts`): `fetch(new URL(path, serverUrl), { headers: { Authorization: \`Bearer ${token}\` }})`, `await res.json().catch(() => ({}))`, status→error-code map, `{ ok: true, data } | { ok: false, error, status? }`. Bundler imports — **no `.js` suffix** on the client side.
- **Auth/server access**: `store.serverUrl`, `store.sessionToken!`, `store.currentUser?.id` (from `authStore.svelte`).
- **Author display name**: resolve from `gateway.members` (the `Member[]` seeded by `ready`); `members` is sorted, so build a lookup `Map<id, Member>` or `members.find(m => m.id === authorId)`. Missing author → show `authorId` (graceful degrade per AC).
- **Max length**: server enforces `MAX_MESSAGE_LENGTH` default **4000** (`server/src/config.ts`), not exposed to the client. Hard-code a matching `MAX_MESSAGE_LENGTH = 4000` client-side constant for the composer guard (server is still authoritative — over-length frames are silently dropped by the gateway).

## Data Flow

**History load (REST):** `channelStore.activeId` changes → `MessagePane` `$effect` calls `messages.ts fetchMessages({ channelId: activeId, limit: 50 })` → `GET /api/channels/:id/messages?limit=50` → `200 PublicMessage[]` **newest-first** → reverse to oldest→newest for display → `gateway.prependHistory(channelId, rows)` upserts each by `id` into the per-channel message map (deduped against any live `message.create` already received) → template renders `gateway.messagesFor(activeId)`.

**Load older:** "load older" → `fetchMessages({ before: <id of oldest currently-held message>, limit: 50 })` → prepend deduped; empty array → no more pages (hide affordance).

**Send (WS):** composer submit → `gateway.sendMessage(activeId, content.trim())` → `socket.send(JSON.stringify({ op: "message.send", d: { channelId, content } }))` (no `attachmentId` — ignored in M2) → server persists + broadcasts `message.create` to **all authed sockets including sender** → `handleFrame` `case "message.create"` upserts by `message.id` → sender renders the authoritative row, deduped against any optimistic copy. No ack; the broadcast is the only effect. Input clears immediately on send (optimistic UX; the row is rendered when the broadcast returns).

**Live receive:** `message.create` for any channel → upsert into that channel's map; active channel updates live, non-active channels are cached without disrupting the view (state lives in the gateway, keyed by channelId, so switching back shows accumulated messages).

**Persistence across reload/reconnect:** relaunch → `ready.channels` reseeds the channel list (gateway) → `MessagePane` `$effect` re-fetches history for the active channel → full prior conversation renders. Live frames missed while offline are recovered from the history fetch.

## Decisions Made

1. **Message state lives in the gateway, not a separate store.** The gateway already owns the only `socket` reference and all server-frame handling; `message.create` must be handled there regardless, and `sendMessage` needs the socket. Keeping the per-channel message cache co-located (like `channels`/`members`) avoids a second module reaching into WS internals and gives one teardown point in `disconnect()`. A separate `messageStore` would have to call back into the gateway to send anyway.
2. **Per-channel cache keyed `Map<channelId, Map<messageId, PublicMessage>>`** (inner map = dedupe by id, per the AC and feature edge cases). Expose `messagesFor(channelId): PublicMessage[]` as a sorted-by-id-ascending array. Non-active channels accumulate without disrupting the active view. Cleared on `disconnect()`.
3. **No optimistic message echo with a temp id.** The server broadcasts `message.create` to the sender too, so the simplest correct path is: clear the input on send, render when the authoritative row arrives. Avoids temp-id↔real-id reconciliation. Latency on a LAN/self-host (~10 users) is negligible; if a perceptible gap appears it can be revisited, but the contract explicitly designed the echo-to-sender to make this unnecessary.
4. **Client `MAX_MESSAGE_LENGTH = 4000` hard-coded** to match the server default (not exposed over any endpoint). Used only for the composer guard / disabled-send; the server remains authoritative (over-length `message.send` is silently dropped). Document the coupling in a comment.
5. **Reverse the newest-first REST page for display.** The contract returns `id DESC`; render oldest→newest, so reverse on ingest. `before` cursor = the oldest (smallest id) message currently held.
6. **Composer lives inside `MessagePane.svelte`** (single component) rather than a separate `Composer.svelte`, matching the create-channel form already inlined in `Presence.svelte`. Split out only if the file grows unwieldy.
7. **Author name resolution via `gateway.members`** with id fallback. No new "author" fetch — the AC explicitly says resolve from the `ready` members map and degrade to the id when absent.

## Open Questions

None — all shapes and flows are fixed by the three upstream contracts; remaining choices (cache shape, optimistic vs. echo, component split) are made above with rationale.
