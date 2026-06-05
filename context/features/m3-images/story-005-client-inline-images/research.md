#research

# Research: Client — render attachments inline in the message pane

## Files to Touch

### Likely Modified
- `client/src/lib/types.ts` — `PublicMessage` is currently **stale**: it has `attachmentId: number | null`, but the story-001/003 contract embeds a full `attachment: PublicAttachment | null` object on every message (live `message.create` and history). Add a `PublicAttachment` interface (mirror the contract, camelCase) and change `PublicMessage.attachmentId` → `attachment: PublicAttachment | null`. This is the load-bearing change — nothing renders inline until the type matches the wire shape.
- `client/src/lib/MessagePane.svelte` — the message `{#each}` loop renders only `<span class="content">`. Add inline image rendering for `msg.attachment !== null`: a child component (see below) that loads the auth-fetched object URL, plus CSS for max-width/height + aspect-ratio. Handle image-only (empty `content`) so no empty text line renders, and text+image together.

### Likely Created
- `client/src/lib/attachmentImages.ts` — the fetch→blob→object-URL helper the AC mandates "alongside the messages store". A module-level `Map<number, ...>` cache keyed by attachment `id` so scrollback/re-render doesn't re-fetch; encapsulates `fetch(GET /api/attachments/:id, Bearer)` → `res.blob()` → `URL.createObjectURL`. No runes (plain `.ts`, bundler imports, no `.js` suffix) — mirrors `messages.ts`/`channels.ts`. Expose a load fn returning a discriminated result (loading/ok/error) and a revoke/teardown path.
- `client/src/lib/InlineImage.svelte` — a small presentational component owning one attachment's lifecycle: `$state` for object-URL + status, an `$effect` that calls the helper and **revokes the object URL on unmount/replacement** (effect cleanup), and the loading-spinner / "image unavailable" affordance. Keeps MessagePane's loop simple and gives a clean per-image teardown point. (Could be folded into MessagePane, but a child component is the idiomatic place for per-item `$effect` cleanup.)

### Read-Only Reference (patterns to follow)
- `client/src/lib/messages.ts` — exact pattern for the auth helper: `URL` building from `serverUrl`, `Authorization: Bearer ${token}` header, try/catch → `network`, status→error mapping, discriminated `{ ok: true; data } | { ok: false; error }` result. The download-into-object-URL snippet is even given verbatim in the story-002 contract.
- `client/src/lib/gateway.svelte.ts` — runes-in-`.svelte.ts` singleton pattern, dedupe-by-id (`upsertMessage`/`prependHistory`), and the `messagesFor()` accessor that feeds the pane. No change needed here — it just carries `PublicMessage` through, so the type fix in `types.ts` propagates automatically once `attachment` is embedded.
- `client/src/lib/authStore.svelte.ts` — where `store.serverUrl` and `store.sessionToken` come from (the two inputs the image helper needs); `store.sessionToken!` is already used non-null in MessagePane's fetch.
- `client/src/lib/config.ts` — `serverUrl` semantics (the base passed to `new URL(path, serverUrl)`).

## Existing Patterns
- **Runes:** reactive singletons live in `*.svelte.ts` modules using module-level `let _x = $state(...)` + a `get` accessor object (see `gateway`, `store`). Components use `$state`, `$derived`, `$effect`. The pane already drives history loading from an `$effect` keyed on `channelStore.activeId` and guards stale async with an id re-check.
- **Plain logic modules** (`messages.ts`, `channels.ts`) are non-runes `.ts`, return discriminated unions, build URLs via `new URL(path, serverUrl)`, send `Authorization: Bearer ${token}`, and map HTTP status → typed error. Follow this for `attachmentImages.ts`.
- **Dedupe-by-id** is already handled in the gateway (`upsertMessage` / `prependHistory` / `messagesFor` sort by id); the pane just renders `gateway.messagesFor(activeId)`. Inline images inherit this for free — same `id` ⇒ rendered once.
- **Display rows:** `{#each messages as msg (msg.id)}` → `<li class="message">` with `.author`, `.time`, `.content` (`.content` already `flex-basis: 100%` so it wraps to its own line — an image block fits the same slot).
- Import style: components import sibling libs **without** `.js` suffix (Vite/bundler), e.g. `import { fetchMessages } from "./messages"`.

## Data Flow
1. Server broadcasts `message.create` (gateway) **or** history `GET /api/channels/:id/messages` (REST via `fetchMessages`) — both embed the **same** `attachment: PublicAttachment | null` per the story-003 contract ("History parity"), no baked URL.
2. `gateway.handleFrame('message.create')` → `upsertMessage` and `fetchMessages` → `gateway.prependHistory` both store the `PublicMessage` (now carrying `attachment`) in the id-keyed per-channel map, deduped by `id`.
3. `MessagePane` reads `gateway.messagesFor(activeId)` (sorted ascending by id) and renders each row.
4. For a row with `msg.attachment !== null`: `<InlineImage>` (given `attachment.id`, plus `store.serverUrl`/`store.sessionToken`) calls `attachmentImages` → cache hit returns the existing object URL; cache miss does `fetch(GET /api/attachments/:id, Authorization: Bearer)` → `res.blob()` → `URL.createObjectURL(blob)`, caches by `id`, returns it.
5. `<img src={objectUrl}>` renders; `attachment.width/height` (nullable) can set an aspect-ratio / reserved box to avoid reflow; CSS caps display size (no server thumbnails). `401`/`404`/network → "image unavailable" affordance; loading → spinner/placeholder.
6. On unmount/replacement the `InlineImage` `$effect` cleanup revokes the object URL. (Cache lifetime decision below governs whether the cache also revokes.)

## Decisions Made
1. **Fix `PublicMessage` to embed `attachment: PublicAttachment | null`** (drop the stale scalar `attachmentId`). The store-001/003 contracts are authoritative and the live + history shapes are identical; the existing client type predates M3 and is wrong. Add `PublicAttachment` mirroring the contract (camelCase, `width/height: number | null`, epoch-ms `createdAt`).
2. **Object-URL via authed fetch, not `<img src>`** — mandated by the AC and the feature spec: `GET /api/attachments/:id` is Bearer-auth-checked and a bare `<img src>` can't send the header (would 401).
3. **Cache by attachment id at module scope in `attachmentImages.ts`** so scrollback/re-render/channel-switch-back don't re-fetch (AC requirement). Because attachment bytes are immutable (link-once, never edited per M3 non-goals), the cache can live for the session. Per-mounted-`<img>` revocation is risky with a shared cache (revoking an in-use URL breaks other rows); the plan should resolve cache-eviction/revoke strategy (e.g. ref-count or simply revoke all on logout/`disconnect`) — the AC's "revoke on unmount/replacement" is satisfied for uncached/superseded URLs; a session-lived cache plus a `clear()` on logout is the simplest correct option.
4. **New presentational `InlineImage.svelte` child** rather than inlining everything in the pane loop — gives each image its own `$state`/`$effect` lifecycle and a clean cleanup hook, keeps the `{#each}` readable, and matches the per-item-component idiom.
5. **CSS-only scaling** (`max-width`/`max-height`, `object-fit`, optional `aspect-ratio` from `attachment.width/height`) — server thumbnails are an explicit feature non-goal.
6. **Image-only rendering:** render `.content` only when `msg.content.trim() !== ""`, and render the image block whenever `msg.attachment` is non-null — so an empty-content image message shows just the image, and text+image shows both.

## Open Questions
None blocking. (Cache eviction/revocation strategy is a plan-level detail, not a research blocker — option laid out in Decision 3.)
