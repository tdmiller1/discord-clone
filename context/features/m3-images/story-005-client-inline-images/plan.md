#plan

# Plan: Client — render attachments inline in the message pane

## Summary
Render images inline in `MessagePane.svelte` for any message whose embedded `attachment` is non-null, both live and from reloaded history, by downloading the auth-checked bytes (`GET /api/attachments/:id`, Bearer) into a session-cached object URL and showing it via a small `InlineImage.svelte` child with loading/error states. Because story-004 runs first and its plan also fixes `client/src/lib/types.ts` (replacing the stale `PublicMessage.attachmentId` scalar with `attachment: PublicAttachment | null` and adding a `PublicAttachment` interface), Step 1 is **check-first / add-only-if-missing** — a no-op when 004 already applied it.

## Implementation Steps

### Step 1: Make `PublicMessage` carry the embedded `attachment` (check-first)
**File(s):** `client/src/lib/types.ts`
**Action:** modify (idempotent — may already be done by story-004)
**Description:** The wire shape (story-001/003 contracts) embeds a full `attachment: PublicAttachment | null` on every message for both live `message.create` and history. The client type predates M3 and is stale (`attachmentId: number | null`). Story-004 is implemented before this story and its plan applies the same fix, so the implementer must FIRST inspect `types.ts`:
- If a `PublicAttachment` interface already exists AND `PublicMessage` already has `attachment: PublicAttachment | null`, do nothing here (no-op) and proceed to Step 2.
- Otherwise apply the changes below. They are the load-bearing prerequisite — nothing renders inline until the type matches the wire shape, and `gateway.svelte.ts` carries `PublicMessage` through unchanged, so the fix propagates automatically.

**Diff shape:**
- Add (if missing): a `PublicAttachment` interface mirroring the contract (camelCase, `width`/`height: number | null`, epoch-ms `createdAt`).
- Change (if still stale): `PublicMessage.attachmentId: number | null` → `attachment: PublicAttachment | null`; drop the now-wrong `// always null in M2` comment.
- No other type touched; `MessageCreatePayload`/`ServerFrame` already reference `PublicMessage` and inherit the new field.

### Step 2: Auth-fetch → object-URL helper with a session-lived id cache
**File(s):** `client/src/lib/attachmentImages.ts`
**Action:** create
**Description:** Plain non-runes `.ts` logic module (mirrors `messages.ts`/`channels.ts`: `new URL(path, serverUrl)`, `Authorization: Bearer ${token}` header, try/catch → `network`, status→typed error, discriminated result). Encapsulates `fetch(GET /api/attachments/:id)` → `res.blob()` → `URL.createObjectURL(blob)`. A module-scope `Map<number, string>` caches the object URL by attachment `id` so scrollback / re-render / channel-switch-back never re-fetch (attachment bytes are immutable per M3 link-once non-goals, so a session lifetime is correct). To avoid a fetch storm when several rows for the same brand-new id mount at once, also keep a `Map<number, Promise<...>>` of in-flight loads and return the shared promise on a concurrent miss. Expose `clearCache()` that revokes every cached URL and empties both maps — called on logout/session-invalid (Step 5). The per-`InlineImage` `$effect` handles revocation of UNcached/superseded URLs (the AC's "revoke on unmount/replacement"); the shared cache is intentionally NOT revoked per-unmount (revoking an in-use URL would break other rows showing the same id) — `clearCache()` is the session-end revoke path.

**Diff shape:**
- Add: `export type AttachmentImageError = "unauthorized" | "not_found" | "network" | "unknown";`
- Add: `export type AttachmentImageResult = { ok: true; objectUrl: string } | { ok: false; error: AttachmentImageError; status?: number };`
- Add: module-scope `const cache = new Map<number, string>();` and `const inflight = new Map<number, Promise<AttachmentImageResult>>();`
- Add: `mapError(status)` → 401 `unauthorized`, 404 `not_found`, else `unknown` (mirrors `messages.ts`).
- Add: `export async function loadAttachmentImage(args: { serverUrl: string; token: string; attachmentId: number }): Promise<AttachmentImageResult>` — cache hit returns `{ ok: true, objectUrl }`; inflight hit awaits the shared promise; miss builds `new URL(\`/api/attachments/${attachmentId}\`, serverUrl)`, fetches with the Bearer header (try/catch → `network`), on `res.ok` does `URL.createObjectURL(await res.blob())`, stores in `cache`, resolves `{ ok: true, objectUrl }`; on non-ok resolves the mapped error. Always deletes the `inflight` entry in a `finally`. Network/error results are NOT cached (so a later retry can succeed).
- Add: `export function clearCache(): void` — `for (const url of cache.values()) URL.revokeObjectURL(url); cache.clear(); inflight.clear();`

### Step 3: `InlineImage.svelte` presentational child (lifecycle + states)
**File(s):** `client/src/lib/InlineImage.svelte`
**Action:** create
**Description:** Owns one attachment's load lifecycle. Props (Svelte 5 `$props`): the `PublicAttachment` (gives `id`, `filename`, `width`, `height`, `contentType`). Reads `store.serverUrl` / `store.sessionToken` from `authStore.svelte`. Holds `$state` for status (`"loading" | "ok" | "error"`) and the resolved `objectUrl`. An `$effect` keyed on `attachment.id` (and the token) calls `loadAttachmentImage(...)`, guards against a stale resolve with a captured-id re-check + a cancelled flag, and sets status/objectUrl. The effect cleanup runs on unmount/`id` change: if the resolved `objectUrl` is NOT the cached one for that id, revoke it (defensive — the helper currently always caches, so this is a safety net for any superseded/uncached URL and satisfies the AC's "revoke on unmount/replacement"). Never lets a rejection escape (helper already returns a result, never throws). Render:
- `status === "loading"` → a placeholder/spinner box (sized from `width`/`height` when present to reserve layout space and avoid reflow).
- `status === "error"` → an "Image unavailable" affordance (no broken `<img>`).
- `status === "ok"` → `<img src={objectUrl} alt={attachment.filename} loading="lazy">` with CSS-only scaling.

**Diff shape:**
- Add: `<script lang="ts">` importing `store`, `loadAttachmentImage`, and `type PublicAttachment`; `$props()` destructure of `{ attachment }`; `$state` for `status`/`objectUrl`; the loading `$effect` with stale-guard + cleanup revoke.
- Add: markup with the three states above.
- Add: scoped `<style>` — `.inline-image img { max-width: min(400px, 100%); max-height: 320px; height: auto; width: auto; object-fit: contain; border-radius: 6px; display: block; }`, an optional `aspect-ratio` on the loading placeholder derived from `width`/`height`, plus muted `.img-loading` / `.img-error` styles using existing `--muted`/`--err` vars.

### Step 4: Render the image block in the message loop
**File(s):** `client/src/lib/MessagePane.svelte`
**Action:** modify
**Description:** In the `{#each messages as msg (msg.id)}` row, render `.content` only when `msg.content.trim() !== ""` (so image-only messages show no empty text line), and render `<InlineImage>` whenever `msg.attachment !== null`. Both `.content` and the image block are `flex-basis: 100%` items in the existing wrapped flex row, so they each wrap to their own line below the author/time. Dedupe-by-id is already handled upstream by the gateway (`upsertMessage`/`prependHistory` + `messagesFor` sort) so live and reloaded-history rows render once and identically — no change needed there.

**Diff shape:**
- Add: `import InlineImage from "./InlineImage.svelte";` to the script.
- Change: the row body from an unconditional `<span class="content">{msg.content}</span>` to:
  - `{#if msg.content.trim() !== ""}<span class="content">{msg.content}</span>{/if}`
  - `{#if msg.attachment !== null}<div class="attachment"><InlineImage attachment={msg.attachment} /></div>{/if}`
- Add: `.attachment { flex-basis: 100%; }` to the `<style>` block so the image wraps to its own line like `.content`.

### Step 5: Clear the image cache on logout / session-invalid
**File(s):** `client/src/App.svelte`
**Action:** modify
**Description:** The session-lived object-URL cache must be revoked + dropped when the session ends, so a re-login with a different account can't show a previous session's blobs and the URLs don't leak. Hook `clearCache()` into the two existing teardown handlers alongside `store.clear()`.

**Diff shape:**
- Add: `import { clearCache as clearAttachmentImages } from "./lib/attachmentImages";` (path is `./lib/...` from `App.svelte`).
- Change: in `handleLogout()` call `clearAttachmentImages();` next to `channelStore.clear();`.
- Change: in `handleSessionInvalid()` call `clearAttachmentImages();` next to `channelStore.clear();`.
- (The stale-token branch in `bootstrap()` calls `store.clear()` but there are no cached images yet at bootstrap, so no change needed there.)

## New Types / Schemas / Contracts

```ts
// client/src/lib/types.ts — added/confirmed in Step 1 (may already exist via story-004)
interface PublicAttachment {
  id: number;
  messageId: number | null;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  createdAt: number; // epoch ms
}
// PublicMessage.attachmentId  ->  attachment: PublicAttachment | null

// client/src/lib/attachmentImages.ts — Step 2
type AttachmentImageError = "unauthorized" | "not_found" | "network" | "unknown";
type AttachmentImageResult =
  | { ok: true; objectUrl: string }
  | { ok: false; error: AttachmentImageError; status?: number };
function loadAttachmentImage(args: {
  serverUrl: string;
  token: string;
  attachmentId: number;
}): Promise<AttachmentImageResult>;
function clearCache(): void;
```

This story **provides no downstream contract** (frontend-only leaf; `provides_contract` is empty in the story frontmatter).

## Configuration / Environment Changes
None. (`store.serverUrl` / `store.sessionToken` already exist; the download path is built from `attachment.id`.)

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| New TS module | `loadAttachmentImage` | `{ serverUrl, token, attachmentId }` | `Promise<AttachmentImageResult>` | Bearer fetch → blob → object URL; id-cached + in-flight-deduped |
| New TS module | `clearCache` | — | `void` | Revokes all cached object URLs; called on logout/session-invalid |
| New component | `InlineImage.svelte` | prop `attachment: PublicAttachment` | rendered `<img>` / spinner / "unavailable" | Owns per-image `$effect` + revoke cleanup |
| Consumed (upstream) | `GET /api/attachments/:id` | path `id`, `Authorization: Bearer` | `200` raw bytes / `401` / `404` / `400` | story-002 contract; no baked URL |
| Type change | `PublicMessage.attachment` | — | `PublicAttachment \| null` | replaces stale `attachmentId`; embedded by gateway + history |

## Edge Cases & Gotchas
- Bare `<img src="/api/attachments/:id">` would `401` (no Bearer header) — must use the authed fetch + object URL. — Steps 2/3
- `401`/`404`/network → "Image unavailable" affordance, never a broken-image icon or unhandled rejection (helper returns a result, never throws). — Steps 2/3
- Image-only message (empty/whitespace `content`) renders just the image, no empty text line; text+image renders both. — Step 4
- Live + history of the same message (reconnect race) deduped by `id` upstream → renders once. — gateway, no change (Step 4 note)
- Re-render / scrollback / channel-switch-back must not re-fetch → module-scope id cache. — Step 2
- Concurrent first-mount of several rows with the same new id → in-flight promise map prevents a duplicate fetch. — Step 2
- Object-URL leak / cross-session bleed → `clearCache()` revokes all on logout/session-invalid; per-image cleanup revokes only superseded/uncached URLs (never an in-use cached one shared by other rows). — Steps 2/3/5
- Layout reflow when images load → reserve space from `attachment.width`/`height` (nullable; skip when absent) via CSS aspect-ratio on the loading box. — Step 3
- Stale async after `attachment.id` change/unmount → `$effect` captures id + cancelled flag and re-checks before applying. — Step 3
- CSS-only scaling (no server thumbnails — feature non-goal): `max-width`/`max-height` + `object-fit: contain`, preserve aspect ratio. — Step 3
- Survives reload (M3 bar): history fetch embeds the same `attachment`; on relaunch the rows re-render and re-fetch the bytes (cold cache) → images reappear. — Steps 1/4

## Acceptance Criteria Checklist
- [ ] Inline image for any message with non-null `attachment`, live + reloaded history, structurally identical, deduped by id → Steps 1, 4 (+ upstream gateway dedupe)
- [ ] Auth-checked bytes via Bearer fetch → object URL, revoked on unmount/replacement, id-cached so scrollback doesn't re-fetch → Steps 2, 3
- [ ] CSS-only scaling (max w/h, aspect ratio preserved, no server thumbnails); width/height may reserve layout space → Step 3
- [ ] Loading spinner/placeholder + graceful "image unavailable" on 401/404/network; no broken-image crash or unhandled rejection → Steps 2, 3
- [ ] Image-only (empty content) renders just the image; text+image renders both → Step 4
- [ ] Survives reload — re-fetched history images reappear inline → Steps 1, 4
- [ ] `npm run typecheck` passes; two-client live + reload check works → all steps (typecheck-clean TS/Svelte; no test runner)
