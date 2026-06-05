#research

# Research: Client — attach & upload an image in the composer

## Files to Touch

### Likely Modified
- `client/src/lib/MessagePane.svelte` — the composer lives here. Add the attach-image
  file picker, the pending/preview affordance with a remove control, the
  upload-in-flight state, client-side guardrails (type/size pre-check), the friendly
  error surface, and the modified submit flow (upload → get id → `sendMessage` with
  `attachmentId`). Today `submitSend` calls `gateway.sendMessage(id, draft.trim())`
  and `canSend` requires non-empty trimmed text; both change to support image-only
  sends and an "uploading…" disabled state.
- `client/src/lib/gateway.svelte.ts` — extend `sendMessage` to accept an optional
  `attachmentId` and include it in the `message.send` frame
  (`{ op: "message.send", d: { channelId, content, attachmentId } }`). Also update the
  `message.create` handling/types if the embedded `attachment` shape is added (the
  handler itself just upserts `frame.d.message`, so mainly a type concern). Optionally
  reset any per-channel state on disconnect (no new state needed for upload).
- `client/src/lib/types.ts` — replace the stale `PublicMessage.attachmentId: number | null`
  placeholder with the contract's `attachment: PublicAttachment | null`, and add the
  `PublicAttachment` interface (id, messageId, filename, contentType, size, width,
  height, createdAt). This aligns the client with both contracts. NOTE: story 005 renders
  attachments and also needs this shape — doing it here is the right place (this story
  "owns" the type change per its AC).

### Likely Created
- `client/src/lib/attachments.ts` — a typed REST helper for `POST /api/attachments`
  (multipart, Bearer), mirroring the structure of `channels.ts`/`messages.ts`/`auth.ts`:
  a discriminated `{ ok: true; data: PublicAttachment } | { ok: false; error, status? }`
  result with an error map (401→unauthorized, 413→file_too_large, 400→
  invalid_image/no_file/not_multipart, network). Keeps fetch/auth logic un-duplicated.

### Read-Only Reference (patterns to follow)
- `client/src/lib/channels.ts` / `client/src/lib/messages.ts` / `client/src/lib/auth.ts` —
  the exact REST-helper idiom to copy: `new URL(path, serverUrl)`,
  `Authorization: Bearer ${token}`, `try/catch → { ok:false, error:"network" }`,
  defensive `res.json().catch(...)`, status→error `mapError`, discriminated result type.
  For multipart, the body is a `FormData` and there is **no** `Content-Type` header (the
  browser sets the multipart boundary). For attachments.ts model on these.
- `client/src/lib/authStore.svelte.ts` — the session layer: `store.sessionToken`
  (Bearer token) and `store.serverUrl` are read directly. MessagePane already imports
  `store` and uses `store.sessionToken!` / `store.serverUrl` for fetchMessages — reuse
  that exact pattern for the upload call.
- `client/src/lib/config.ts` — client config layer (localStorage-backed). There is **no**
  `MAX_UPLOAD_MB` exposed to the client today; mirror the server default (10 MB) as a
  local const, the same way MessagePane hard-codes `MAX_MESSAGE_LENGTH = 4000` with a
  comment that the server stays authoritative.

## Existing Patterns
- **REST helpers** are plain TS modules (no runes), one file per endpoint group, each
  exporting a discriminated `Result` union and a `mapError(status, bodyError)`. Functions
  take a single `args` object `{ serverUrl, token, ... }`. Bundler imports use **no `.js`
  suffix** (client is Vite, unlike the ESM server).
- **Reactive stores** live in `*.svelte.ts` modules using Svelte 5 runes
  (`$state`, `$derived`) with getter-based singleton objects (`gateway`, `store`,
  `channelStore`).
- **Component state** uses runes inline: `let draft = $state("")`,
  `const canSend = $derived(...)`, `$effect(...)` for channel-change fetches,
  `onsubmit`/`onclick` (Svelte 5 event attributes, not `on:`). The composer is a
  `<form onsubmit={submitSend}>` with `event.preventDefault()`.
- **Authoritative-render pattern:** the client does NOT optimistically insert; it clears
  `draft` and waits for the server's `message.create` broadcast (the sender gets its own
  echo). Keep this — clear the pending image only after a successful upload + send.
- **Hard-coded server mirror constant** with a justifying comment (see `MAX_MESSAGE_LENGTH`).

## Data Flow
1. User clicks the attach control → hidden `<input type="file" accept="image/png,image/jpeg,image/gif,image/webp">`
   fires; the selected `File` is held in `$state` (e.g. `pendingFile`), with a small
   preview (filename, or an object URL thumbnail) and a remove button.
2. Client guardrails: pre-check `file.type` ∈ allowed set and `file.size ≤ MAX_UPLOAD_MB`;
   fail fast with a friendly message (server stays source of truth).
3. On submit (image-only allowed; blocked iff neither text nor image): set an
   `uploading` flag (disable composer), call the new `attachments.ts` helper →
   `POST /api/attachments` with `FormData` field `file` + `Authorization: Bearer
   ${store.sessionToken}` against `store.serverUrl`. Per the REST contract this returns
   `201 PublicAttachment` (camelCase, **no `url`**, `messageId: null`).
4. On upload success: take `data.id` and call
   `gateway.sendMessage(channelId, draft.trim(), data.id)`, which sends
   `message.send { channelId, content, attachmentId }` over the WS (per the gateway
   contract: `attachmentId` must be a positive integer; image-only content allowed).
   Clear `draft` + `pendingFile`, revoke any preview object URL, clear `uploading`.
5. On upload failure (413/400/401/network): surface a friendly error, keep the typed text
   and the pending image, clear `uploading`.
6. Server validates ownership + link-once, inserts the message linking the attachment,
   and broadcasts `message.create` with the embedded `attachment` (`PublicAttachment`,
   `messageId` now set). The gateway's existing `message.create` handler upserts it by id;
   rendering the image is story 005.

## Decisions Made
1. **Add a dedicated `attachments.ts` REST helper** rather than inlining the multipart
   fetch in the component — matches the one-module-per-endpoint convention and keeps
   fetch/auth logic un-duplicated (an explicit AC). It returns the frozen
   `PublicAttachment` from the contract.
2. **`gateway.sendMessage` gains an optional 3rd arg `attachmentId?: number`** and only
   includes the field in `d` when it's a positive integer (omit/`null` otherwise), so the
   plain-text path stays byte-for-byte the M2 frame and the attachment path matches the
   story-003 contract.
3. **Update `types.ts` now**: `PublicMessage.attachment: PublicAttachment | null` replaces
   the inert `attachmentId` placeholder, and `PublicAttachment` is added. The contracts
   make this the canonical wire shape; story 005 consumes the same type. The story's AC
   explicitly calls for replacing/augmenting the placeholder here.
4. **No multipart `Content-Type` header** — build a `FormData`, append the `File` under
   field name `file`, and let the browser set the boundary. (A manually set
   `multipart/form-data` header would break the boundary.)
5. **Client size/type guard mirrors the server** with a local `MAX_UPLOAD_MB = 10` const
   (no client config plumbing exists; mirror-with-comment like `MAX_MESSAGE_LENGTH`). The
   server remains authoritative; the guard is just fail-fast UX.
6. **Image preview** uses `URL.createObjectURL(file)` and is revoked on remove/after send
   to avoid leaks (no network fetch needed pre-send since we hold the local File).
