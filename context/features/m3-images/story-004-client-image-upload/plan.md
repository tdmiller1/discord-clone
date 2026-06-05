#plan

# Plan: Client — attach & upload an image in the composer

## Summary
Add an attach-image control to the composer that pre-validates an image, uploads it
via a new `attachments.ts` REST helper (`POST /api/attachments`), then sends
`message.send { channelId, content, attachmentId }` over the gateway — extending
`MessagePane.svelte`, `gateway.svelte.ts`, and `types.ts`. The `types.ts` change
(replacing the stale `PublicMessage.attachmentId` placeholder with
`attachment: PublicAttachment | null` and adding `PublicAttachment`) is the contract
wire shape that story-005 also needs; because implementation is serial (004 then 005),
this story owns it. It is designed idempotently — once present, story-005's implementer
can no-op it (the shape is the same, so 005 simply consumes it).

## Implementation Steps

### Step 1: Add `PublicAttachment` and fix `PublicMessage` in client types
**File(s):** `client/src/lib/types.ts`
**Action:** modify
**Description:** Replace the inert `attachmentId: number | null` placeholder on
`PublicMessage` with the contract's embedded `attachment: PublicAttachment | null`, and
add the `PublicAttachment` interface (exact frozen shape from the story-002/003 contracts).
This aligns the client wire types with `message.create` and history. Story-005 consumes the
same type; if it is already present when 005 runs, that step is a no-op.
**Diff shape:**
- Add: `PublicAttachment` interface — `{ id: number; messageId: number | null; filename: string; contentType: string; size: number; width: number | null; height: number | null; createdAt: number }`.
- Change: on `PublicMessage`, replace `attachmentId: number | null; // always null in M2 (images arrive M3)` with `attachment: PublicAttachment | null;`.
- Update the `PublicMessage` doc comment to drop the "always null in M2" note.

### Step 2: Create the `attachments.ts` REST helper
**File(s):** `client/src/lib/attachments.ts`
**Action:** create
**Description:** A typed, runes-free REST module for `POST /api/attachments`, mirroring
`channels.ts`/`messages.ts`/`auth.ts`: single `args` object, `new URL(path, serverUrl)`,
`Authorization: Bearer` header, `try/catch → { ok:false, error:"network" }`, defensive
`res.json().catch(...)`, and a status→error `mapError`. Body is a `FormData` with the
`File` appended under field name `file`; **no `Content-Type` header** so the browser sets
the multipart boundary. Returns a discriminated result carrying the frozen
`PublicAttachment` on success (201).
**Diff shape:**
- Add: `AttachmentErrorCode = "unauthorized" | "file_too_large" | "invalid_image" | "no_file" | "not_multipart" | "bad_request" | "network" | "unknown"`.
- Add: `AttachmentResult = { ok: true; data: PublicAttachment } | { ok: false; error: AttachmentErrorCode; status?: number }`.
- Add: `mapError(status, bodyError)` — 401→unauthorized, 413→file_too_large, 400→ map `bodyError` (`invalid_image`/`no_file`/`not_multipart`) else `bad_request`, else unknown.
- Add: `uploadAttachment(args: { serverUrl; token; file: File }): Promise<AttachmentResult>` — builds `FormData`, appends `file`, `fetch(POST)` with only the `Authorization` header, success on 201 returns `data as PublicAttachment`.

### Step 3: Extend `gateway.sendMessage` to carry an optional `attachmentId`
**File(s):** `client/src/lib/gateway.svelte.ts`
**Action:** modify
**Description:** Add an optional 3rd parameter `attachmentId?: number` to `sendMessage`.
Include `attachmentId` in the `message.send` `d` payload **only** when it is a positive
integer, so the plain-text path stays byte-for-byte the M2 frame and the attachment path
matches the story-003 contract (positive-integer rule). The existing `message.create`
handler already upserts `frame.d.message` by id, so no handler change is needed beyond the
type flowing through from Step 1.
**Diff shape:**
- Change: signature `sendMessage(channelId: number, content: string, attachmentId?: number): void`.
- Change: build `const d = { channelId, content }` then, `if (Number.isInteger(attachmentId) && attachmentId! > 0) (d as { attachmentId?: number }).attachmentId = attachmentId;` before `socket.send(JSON.stringify({ op: "message.send", d }))`.
- Update the `sendMessage` doc comment to note the optional attachment.

### Step 4: Wire the attach control, preview, guardrails, and upload flow into the composer
**File(s):** `client/src/lib/MessagePane.svelte`
**Action:** modify
**Description:** Add the attach-image affordance and the upload-then-send flow per the
data flow in research. New `$state`: `pendingFile: File | null`, `previewUrl: string | null`,
`uploading: boolean`, `uploadErr: string`. A hidden `<input type="file">` (scoped to the
allowed types) is triggered by an attach button; selecting a file runs client-side
guardrails (allowed type + size ≤ `MAX_UPLOAD_MB`) and, if valid, stores the `File` and an
object-URL preview with a remove control. `canSend` is relaxed to allow image-only sends and
to block while uploading. `submitSend` becomes async: if a `pendingFile` is present it
uploads first via `uploadAttachment`, and only on success sends with the returned id and
clears state; on failure it surfaces a friendly error and keeps both the text and the
pending image.
**Diff shape:**
- Add: imports `import { uploadAttachment } from "./attachments";` and `import type { AttachmentErrorCode } from "./attachments";`.
- Add: `const MAX_UPLOAD_MB = 10;` and `const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;` and `const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;` each with a "server stays authoritative" comment mirroring `MAX_MESSAGE_LENGTH`.
- Add: `let pendingFile = $state<File | null>(null);`, `let previewUrl = $state<string | null>(null);`, `let uploading = $state(false);`, `let uploadErr = $state("");`, plus `let fileInput: HTMLInputElement;` bound to the hidden input.
- Change: `canSend` → `activeChannel !== null && !uploading && (pendingFile !== null || draft.trim() !== "") && draft.trim().length <= MAX_MESSAGE_LENGTH` (image-only allowed; over-length still blocked; disabled while uploading).
- Add: `function onPickFile(event: Event)` — read `input.files?.[0]`; if missing return; reset the input value (so re-picking the same file refires); validate `ALLOWED_IMAGE_TYPES.includes(file.type)` and `file.size <= MAX_UPLOAD_BYTES`; on fail set `uploadErr` (friendly "Only PNG, JPEG, GIF, or WebP images." / "Image is larger than 10 MB."); on pass clear `uploadErr`, revoke any existing `previewUrl`, set `pendingFile` + `previewUrl = URL.createObjectURL(file)`.
- Add: `function clearPending()` — revoke `previewUrl` if set, null out `pendingFile`/`previewUrl`, clear `fileInput.value`.
- Change: `submitSend` → `async`: `event.preventDefault(); if (!canSend || activeChannel === null) return; uploadErr = "";` — if `pendingFile === null`, keep the existing text-only path (`gateway.sendMessage(id, draft.trim()); draft = "";`). Otherwise: capture `const channelId = activeChannel.id; uploading = true;` call `uploadAttachment({ serverUrl: store.serverUrl, token: store.sessionToken!, file: pendingFile });` then `uploading = false;` — on `result.ok` call `gateway.sendMessage(channelId, draft.trim(), result.data.id)`, then `draft = ""` and `clearPending()`; on failure set `uploadErr = uploadErrorMessage(result.error)` and keep `draft` + `pendingFile`.
- Add: `function uploadErrorMessage(code: AttachmentErrorCode): string` — friendly strings for `unauthorized` ("Your session expired. Please sign in again."), `file_too_large`, `invalid_image`, `no_file`/`not_multipart`/`bad_request` (generic "That image couldn't be uploaded."), `network` ("Could not reach the server."), fallback unknown.
- Add (markup): an attach button (`type="button"`, onclick `fileInput.click()`, disabled while `uploading`) before/after the text input, plus the hidden `<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" bind:this={fileInput} onchange={onPickFile} hidden />`.
- Add (markup): a pending-preview block shown `{#if pendingFile}` — small thumbnail (`<img src={previewUrl} alt={pendingFile.name} />`), the filename, and a remove button (`type="button"`, onclick `clearPending`, disabled while `uploading`).
- Add (markup): `{#if uploading}` an "Uploading…" hint and `{#if uploadErr}` an `.err` line near the composer.
- Change: disable the text input and Send button appropriately while `uploading` (Send already covered by `canSend`; add `disabled={uploading}` to the text input and attach/remove buttons).
- Add (style): minimal CSS for the attach button, the preview row, and the thumbnail (e.g. `max-height: 3rem`); reuse the existing `.err`/`.hint` classes.

## New Types / Schemas / Contracts

```ts
// client/src/lib/types.ts — added
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

// client/src/lib/types.ts — PublicMessage now embeds the attachment
interface PublicMessage {
  id: number;
  channelId: number;
  authorId: number;
  content: string;
  attachment: PublicAttachment | null; // was: attachmentId: number | null
  createdAt: number;
}

// client/src/lib/attachments.ts — new
type AttachmentErrorCode =
  | "unauthorized" | "file_too_large" | "invalid_image"
  | "no_file" | "not_multipart" | "bad_request" | "network" | "unknown";
type AttachmentResult =
  | { ok: true; data: PublicAttachment }
  | { ok: false; error: AttachmentErrorCode; status?: number };
function uploadAttachment(args: {
  serverUrl: string; token: string; file: File;
}): Promise<AttachmentResult>;
```

No new server-facing contracts; this story only consumes the story-002 (REST) and
story-003 (gateway) contracts.

## Configuration / Environment Changes
None. `MAX_UPLOAD_MB` is hard-coded (`= 10`) in `MessagePane.svelte` with a
"server stays authoritative" comment, mirroring the existing `MAX_MESSAGE_LENGTH`
pattern — there is no client config layer that exposes the upload limit today.

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| Client REST helper | `uploadAttachment({ serverUrl, token, file })` | `POST /api/attachments`, `multipart/form-data` field `file`, `Authorization: Bearer`, no `Content-Type` header | `{ ok: true, data: PublicAttachment }` (201) or `{ ok: false, error, status? }` | New module `attachments.ts`; per attachments-rest-api contract |
| Client gateway | `gateway.sendMessage(channelId, content, attachmentId?)` | adds optional positive-integer `attachmentId` | `void` (fire-and-forget; server echoes `message.create`) | `attachmentId` included in `d` only when `Number.isInteger && > 0` |
| Client type | `PublicMessage.attachment` | n/a | `PublicAttachment \| null` | Replaces stale `attachmentId` placeholder; shared with story-005 |

## Edge Cases & Gotchas
- **No multipart `Content-Type` header** — `FormData` only; a manual header breaks the boundary — Step 2.
- **Image-only send allowed; empty-empty blocked** — `canSend` requires `pendingFile !== null || draft.trim() !== ""` — Step 4.
- **Re-picking the same file** — reset `input.value` after reading so `onchange` refires for an identical path — Step 4 (`onPickFile`/`clearPending`).
- **Object-URL leak** — `URL.createObjectURL` is revoked on remove and after a successful send; re-picking revokes the previous one — Step 4. (No mount/unmount churn: the preview block is conditional, and `clearPending` runs on success.)
- **Preserve typed text on failure** — on upload error, `draft` and `pendingFile` are untouched; only `uploadErr` is set, `uploading` cleared — Step 4.
- **Client guard mirrors but does not replace the server** — type/size pre-check is fail-fast UX; the server re-sniffs bytes and re-checks size and stays authoritative — Steps 2/4.
- **Stale-channel race** — capture `channelId` before the await so a slow upload that resolves after a channel switch still sends to the originally-targeted channel (matches the existing `fetchMessages` capture pattern) — Step 4.
- **401 during upload** — surfaced as a friendly "session expired" message; the existing WS 4001 path independently routes back to login, so no extra session handling is added here — Step 4.
- **Idempotent `types.ts` change vs story-005** — the `PublicAttachment` shape is identical to what 005 needs; once added here, 005's implementer no-ops it — Step 1.

## Acceptance Criteria Checklist
- [ ] Composer gains an attach-image control scoped to `image/png,image/jpeg,image/gif,image/webp` with a pending preview + remove affordance → Step 4
- [ ] On send: multipart `POST /api/attachments` with the session token, then `message.send { channelId, content, attachmentId }`; image-only send allowed; neither-text-nor-image blocked client-side → Steps 2, 3, 4
- [ ] Upload UX: composer indicates "uploading…", surfaces a friendly error on rejection without losing typed text, clears the pending image only on success → Step 4
- [ ] Client-side guardrails mirror the server (allowed type + size pre-check) with the server as source of truth → Step 4
- [ ] Reuses/extends existing client types (`PublicMessage.attachment` + `PublicAttachment`) and the gateway/REST + session helpers; no duplicated fetch/auth logic → Steps 1, 2, 3
- [ ] `npm run typecheck` passes; verifiable by running the client (pick → send → `message.create` round-trips, file exists server-side) → all steps
