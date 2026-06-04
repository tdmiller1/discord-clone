#plan

# Plan: Client — message history, composer & live updates

## Summary
Add a client message pane that fetches a channel's recent history over REST, sends/receives messages live over the WS gateway, dedupes by id, and persists across reload via the history fetch — closing the M2 end-to-end loop. Per-channel message state and `message.create`/`sendMessage` live on the existing `gateway` singleton; a new `messages.ts` REST client and a `MessagePane.svelte` component (composer inlined) drive the UI.

Resolved choices (no open questions remained in research): composer is **inlined in `MessagePane.svelte`** (matches the create-channel form inlined in `Presence.svelte`); **no optimistic echo** (the server broadcasts `message.create` to the sender); client `MAX_MESSAGE_LENGTH = 4000` hard-coded to match the server default; newest-first REST pages are reversed to oldest→newest on ingest; per-channel cache keyed `Map<channelId, Map<messageId, PublicMessage>>`.

## Implementation Steps

### Step 1: Add client message types
**File(s):** `client/src/lib/types.ts`
**Action:** modify
**Description:** Add the client `PublicMessage` mirror (story-003 shape), the `MessageCreatePayload` shape, and extend the `ServerFrame` discriminated union with the `message.create` frame so the gateway's `handleFrame` switch type-narrows.
**Diff shape:**
- Add: `export interface PublicMessage { id: number; channelId: number; authorId: number; content: string; attachmentId: number | null; createdAt: number; }`
- Add: `export interface MessageCreatePayload { message: PublicMessage; }`
- Change: `ServerFrame` union gains `| Envelope<"message.create", MessageCreatePayload>`.

### Step 2: Create the messages REST client
**File(s):** `client/src/lib/messages.ts`
**Action:** create
**Description:** Typed REST client for `GET /api/channels/:id/messages`, mirroring `channels.ts` (URL building, `Authorization: Bearer`, discriminated result, defensive JSON parse, network→result, status→error-code map). Returns `PublicMessage[]` **newest-first** exactly as the server sends; callers reverse for display.
**Diff shape:**
- Add: `type MessagesErrorCode = "channel_not_found" | "bad_request" | "unauthorized" | "network" | "unknown"`.
- Add: `type MessagesResult = { ok: true; data: PublicMessage[] } | { ok: false; error: MessagesErrorCode; status?: number }`.
- Add: `mapError(status)` → 401→`unauthorized`, 404→`channel_not_found`, 400→`bad_request`, else `unknown`.
- Add: `async function fetchMessages({ serverUrl, token, channelId, before?, limit? }): Promise<MessagesResult>` — builds `/api/channels/${channelId}/messages` with `?before=`/`?limit=` query params only when provided, `try/catch`→`network`, `await res.json().catch(() => ([]))`, `200`→`{ ok: true, data }`.

### Step 3: Add message state, `sendMessage`, and the `message.create` handler to the gateway
**File(s):** `client/src/lib/gateway.svelte.ts`
**Action:** modify
**Description:** Co-locate the per-channel message cache with `channels`/`members` (the gateway owns the only `socket` and all frame handling). Add a reactive `Map<channelId, Map<messageId, PublicMessage>>`, an upsert helper, a `case "message.create"` branch, a `messagesFor(channelId)` getter returning a sorted-ascending array, a `prependHistory(channelId, msgs)` ingest method (history + load-older), and a public `sendMessage(channelId, content)`. Reset the message map in `disconnect()`.
**Diff shape:**
- Add import: extend the `import type` line with `MessageCreatePayload` is not needed (only `PublicMessage` for the map type) — add `PublicMessage`, and the union member is already wired via `ServerFrame`. Add `import { store }` is already present.
- Add: `let _messages = $state(new Map<number, Map<number, PublicMessage>>());`
- Add helper: `function upsertMessage(channelId, msg)` — get-or-create the inner `Map`, `inner.set(msg.id, msg)`, then reassign the outer map (`_messages = new Map(_messages)`) so derived reads recompute (Svelte Maps aren't deeply reactive — mirror the `_channels` reassign pattern).
- Change `handleFrame`: add `case "message.create": { upsertMessage(frame.d.message.channelId, frame.d.message); break; }` before `default`.
- Add to the exported `gateway` object: `messagesFor(channelId: number): PublicMessage[]` → `[...(_messages.get(channelId)?.values() ?? [])].sort((a, b) => a.id - b.id)`.
- Add: `prependHistory(channelId: number, msgs: PublicMessage[]): void` → upsert each by id (dedupes against any live `message.create` already cached), one outer-map reassign.
- Add: `sendMessage(channelId: number, content: string): void` → guard `socket` is non-null and `socket.readyState === WebSocket.OPEN`; `socket.send(JSON.stringify({ op: "message.send", d: { channelId, content } }))` (no `attachmentId`). No optimistic insert — the broadcast echoes back.
- Change `disconnect()`: add `_messages = new Map();`.

### Step 4: Create the MessagePane component (history + live render + composer)
**File(s):** `client/src/lib/MessagePane.svelte`
**Action:** create
**Description:** The single signed-in message pane. Resolves the active channel from `gateway.channels` + `channelStore.activeId`; on `activeId` change fetches the latest page and seeds gateway history; renders `gateway.messagesFor(activeId)` oldest→newest with author names resolved from `gateway.members` (id fallback); offers a "load older" affordance using the oldest held id as the `before` cursor; inlines the composer form. Renders an empty/placeholder state when `activeChannel` is `null`.
**Diff shape:**
- Add `<script lang="ts">` importing `store`, `channelStore`, `gateway`, `fetchMessages`, and `PublicMessage`/`Member` types.
- Add `const MAX_MESSAGE_LENGTH = 4000;` with a comment documenting the server-default coupling (`server/src/config.ts`; over-length frames are silently dropped server-side — client guard is UX only).
- Add `const activeChannel = $derived(gateway.channels.find((c) => c.id === channelStore.activeId) ?? null);`
- Add `const messages = $derived(channelStore.activeId === null ? [] : gateway.messagesFor(channelStore.activeId));`
- Add author lookup: `const memberById = $derived(new Map(gateway.members.map((m) => [m.id, m])));` and a `authorName(id)` helper → `memberById.get(id)?.displayName ?? memberById.get(id)?.username ?? String(id)`.
- Add load state: `let loadStatus = $state<"idle" | "loading" | "error">("idle");`, `let hasMore = $state(false);`, `let loadErr = $state("");`.
- Add `$effect` keyed on `channelStore.activeId`: capture the id, set `loadStatus = "loading"`, `await fetchMessages({ serverUrl, token, channelId: id, limit: 50 })`; on success reverse → `gateway.prependHistory(id, [...data].reverse())`, `hasMore = data.length === 50`, `loadStatus = "idle"`; on failure set error. Guard against a stale channel by re-checking `channelStore.activeId === id` before applying (the user may have switched mid-fetch).
- Add `loadOlder()`: `before = messages[0]?.id`; if undefined return; `fetchMessages({ before, limit: 50 })`; `prependHistory`; `hasMore = data.length === 50`.
- Add composer state: `let draft = $state("");` and `const canSend = $derived(activeChannel !== null && draft.trim() !== "" && draft.trim().length <= MAX_MESSAGE_LENGTH);`.
- Add `submitSend(event)`: `preventDefault`; `if (!canSend) return`; `gateway.sendMessage(activeChannel!.id, draft.trim()); draft = "";` (clear immediately — row renders on broadcast).
- Add template: when `activeChannel === null` render a placeholder; else a "load older" button (shown when `hasMore`), the `{#each messages as msg (msg.id)}` list rendering `authorName(msg.authorId)`, a plain-text content node, and a timestamp; then the `<form onsubmit={submitSend}>` with `<input bind:value={draft}>` + a submit button `disabled={!canSend}`. Content rendered as plain text (Svelte `{msg.content}` escapes by default — no `{@html}`, no markdown).
- Add minimal scoped `<style>` matching the existing card/`--muted`/`--accent` design tokens.

### Step 5: Mount the MessagePane in the signed-in screen
**File(s):** `client/src/lib/Presence.svelte`
**Action:** modify
**Description:** Host `<MessagePane />` next to the channel list / members sections (the single signed-in screen). The pane reads `channelStore`/`gateway` itself, so no props are required. Minor layout/CSS so the pane sits alongside the existing cards.
**Diff shape:**
- Add: `import MessagePane from "./MessagePane.svelte";`
- Add: `<MessagePane />` in the `<main>` layout (e.g. between/after the Channels card and the Members card, or in a center column).
- Change: optional CSS tweak to lay out the pane (no behavior change to existing channel/member logic).

## New Types / Schemas / Contracts

```ts
// client/src/lib/types.ts
export interface PublicMessage {
  id: number;
  channelId: number;
  authorId: number;
  content: string;
  attachmentId: number | null; // always null in M2
  createdAt: number;           // epoch ms
}
export interface MessageCreatePayload { message: PublicMessage; }
type ServerFrame =
  | Envelope<"ready", ReadyPayload>
  | Envelope<"presence.update", PresenceUpdatePayload>
  | Envelope<"channel.create", ChannelCreatePayload>
  | Envelope<"message.create", MessageCreatePayload>; // added
```

```ts
// client/src/lib/messages.ts
type MessagesErrorCode = "channel_not_found" | "bad_request" | "unauthorized" | "network" | "unknown";
type MessagesResult =
  | { ok: true; data: PublicMessage[] }            // newest-first, as the server returns
  | { ok: false; error: MessagesErrorCode; status?: number };
function fetchMessages(args: {
  serverUrl: string; token: string; channelId: number; before?: number; limit?: number;
}): Promise<MessagesResult>;
```

```ts
// client/src/lib/gateway.svelte.ts — added to the gateway singleton
messagesFor(channelId: number): PublicMessage[];          // sorted ascending by id
prependHistory(channelId: number, msgs: PublicMessage[]): void; // upsert/dedupe by id
sendMessage(channelId: number, content: string): void;    // op "message.send"
```

Outbound WS frame: `{ op: "message.send", d: { channelId, content } }` (no `attachmentId` — ignored in M2).

## Configuration / Environment Changes
None (no env/columns). One client-side constant: `MAX_MESSAGE_LENGTH = 4000` in `MessagePane.svelte`, hard-coded to mirror the server default (`server/src/config.ts`); the server stays authoritative.

## API / Interface Changes
| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| REST client | `fetchMessages` | `{ serverUrl, token, channelId, before?, limit? }` | `MessagesResult` (`PublicMessage[]` newest-first) | New `messages.ts`; mirrors `channels.ts`; `GET /api/channels/:id/messages` |
| Gateway method | `gateway.sendMessage` | `(channelId, content)` | `void` (fire-and-forget WS) | Sends `message.send`; guards socket OPEN |
| Gateway method | `gateway.messagesFor` | `(channelId)` | `PublicMessage[]` ascending by id | Reactive read |
| Gateway method | `gateway.prependHistory` | `(channelId, msgs[])` | `void` | Upsert/dedupe by id |
| WS frame (in) | `message.create` | n/a | `{ message: PublicMessage }` | Handled in `handleFrame`; upsert by id |
| Component | `MessagePane.svelte` | none (reads stores) | rendered pane + composer | Mounted in `Presence.svelte` |

## Edge Cases & Gotchas
- **History/live dedupe by id** — inner `Map<messageId, …>` keys on id; both `prependHistory` and `message.create` upsert, so a reconnect race renders each message once. (Step 3)
- **Non-active channels cached without disrupting the view** — message state is keyed by channelId on the gateway; switching back shows accumulated messages; only `messagesFor(activeId)` is rendered. (Step 3, Step 4)
- **Author missing from `members`** — `authorName` falls back to `username`, then to `String(id)`. (Step 4)
- **Stale fetch on rapid channel switch** — the `$effect` captures the id and re-checks `channelStore.activeId === id` before applying results, so a slow fetch for a deselected channel doesn't clobber the view (state still lands in that channel's cache, but `hasMore`/`loadStatus` only apply to the current channel). (Step 4)
- **Empty / whitespace / over-max content** — `canSend` guard disables send and `submitSend` returns early; server also silently drops bad frames. (Step 4)
- **No optimistic echo** — input clears on send; the authoritative row renders when the `message.create` broadcast returns (avoids temp-id reconciliation; LAN latency negligible). (Step 3, Step 4)
- **`activeChannel === null`** (empty server, no selection) — render a placeholder, no fetch. (Step 4)
- **Svelte Map reactivity** — every mutation reassigns the outer `_messages` map so `messagesFor`/derived reads recompute (mirrors the `_channels` pattern). (Step 3)
- **Plain text only** — content rendered via `{msg.content}` (auto-escaped); no `{@html}`, markdown, mentions, or attachment rendering (M3). (Step 4)
- **`before` cursor** — `loadOlder` uses `messages[0].id` (oldest held, since the list is ascending); an empty page (`length < 50`) hides the affordance. (Step 4)
- **Bundler imports** — client modules use **no `.js` suffix** (unlike the ESM server). (Steps 1–5)

## Acceptance Criteria Checklist
- [ ] Active-channel change fetches `GET /api/channels/:id/messages?limit=50`, renders oldest→newest, resolves author names from `members`, degrades to id → Steps 2, 4
- [ ] Composer sends `message.send { channelId, content }` for the active channel; input clears; empty/whitespace/over-max prevented client-side → Steps 3, 4
- [ ] Incoming `message.create` for the active channel appended live; non-active channels cached without disrupting view; deduped by id → Steps 1, 3
- [ ] Older messages loadable via the `before` keyset cursor; latest page renders with a "load older" affordance when more exist → Steps 2, 4
- [ ] Persistence across reload/reconnect: `ready.channels` + history fetch show the channel list and active channel's history → Steps 3 (existing `ready`), 4
- [ ] Content rendered as plain text; attachments not rendered → Step 4
- [ ] `npm run typecheck` passes; two clients see live + persisted messages → all steps (verify after Step 5)
