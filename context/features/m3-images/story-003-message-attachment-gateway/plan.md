#plan

# Plan: Gateway — link attachmentId on message.send & embed attachment in broadcasts

## Summary
Extend the M2 `message.send` handler in `server/src/ws/gateway.ts` to honor `attachmentId`: validate ownership/existence/link-once via story 001's accessors, relax the content-required rule when a valid attachment is present, atomically insert the message with `attachment_id` set and link the attachment, then broadcast a `message.create` whose `PublicMessage` embeds the attachment (read via `getMessageWithAttachment`). History parity already exists from story 001, so no read-side change is needed.

## Decisions (resolving research, not all explicit in story)
- **Reject = silently drop the frame (`return;`)**, matching every existing M2 invalid-`message.send` path; the gateway has no error-op precedent and no client (004/005) is told to expect one. (research Decision 1.)
- **Set `attachment_id` on the message row** by passing the real `attachmentId` to `insertMessage` (not `null` as story-001's usage note suggested). The story-003 acceptance criterion explicitly requires `attachment_id` set, and `getMessageWithAttachment` joins on `m.attachment_id`, so the column must carry the value. (research Decision 2 — binding over the upstream note.)
- **Atomicity via `db.transaction(() => {...})()`** (better-sqlite3 synchronous), mirroring `seedVoiceChannel`. The insert and the link commit together or not at all.
- **Pre-validate** ownership/existence/unlinked with `getAttachmentById` *before* the transaction; the in-transaction `linkAttachmentToMessage === true` assertion (throw on `false`) is the concurrency backstop that rolls back rather than persisting a half-linked / orphan message.
- **`attachmentId` typing:** absent / `null` / `undefined` = no attachment (M2 path, byte-for-byte). A present value must be a finite positive integer; anything else present-but-invalid → reject.

## Implementation Steps

### Step 1: Import the attachment accessors and the single-message read helper
**File(s):** `server/src/ws/gateway.ts`
**Action:** modify
**Description:** The handler needs `getAttachmentById` + `linkAttachmentToMessage` (from `attachments.js`) and `getMessageWithAttachment` (from `channels.js`) to validate, link, and re-read the embedded row for the broadcast.
**Diff shape:**
- Change import from `../channels.js`: add `getMessageWithAttachment` to the existing `{ getChannelById, insertMessage, listChannels }`.
- Add: `import { getAttachmentById, linkAttachmentToMessage } from "../attachments.js";`

### Step 2: Parse and typecheck `attachmentId` in the post-auth `message.send` block
**File(s):** `server/src/ws/gateway.ts`
**Action:** modify
**Description:** After extracting `content`, pull `attachmentId` from `d`. Treat absent/`null`/`undefined` as "no attachment". When present, it must be a finite positive integer; otherwise reject (`return;`). Capture a `hasAttachment` boolean and a narrowed `attachmentId: number`.
**Diff shape:**
- Add (after the `content` typecheck): read `const rawAttachmentId = (d as { attachmentId?: unknown }).attachmentId;`
- Add: if `rawAttachmentId !== undefined && rawAttachmentId !== null`, require `typeof === "number" && Number.isInteger && > 0` else `return;`. Set `attachmentId` (number) and `hasAttachment = true`. Otherwise `hasAttachment = false`.

### Step 3: Relax the content-required rule when an attachment is present
**File(s):** `server/src/ws/gateway.ts`
**Action:** modify
**Description:** The M2 rule rejects empty/whitespace content. Per the content rule, empty content is allowed **iff** a valid attachment is attached. The max-length check still applies unconditionally.
**Diff shape:**
- Change the existing guard `if (trimmed.length === 0 || content.length > config.maxMessageLength) return;` into two checks:
  - `if (content.length > config.maxMessageLength) return;` (always).
  - `if (trimmed.length === 0 && !hasAttachment) return;` (empty content only allowed with an attachment).

### Step 4: Validate the attachment before persisting (ownership / existence / unlinked)
**File(s):** `server/src/ws/gateway.ts`
**Action:** modify
**Description:** When `hasAttachment`, load the row via `getAttachmentById`. Reject (`return;`, no persist) if it does not exist, `uploader_id !== state.userId`, or `message_id !== null`. Place this after the `getChannelById` existence check so a bad channel still short-circuits.
**Diff shape:**
- Add: `let attachment: AttachmentRow | undefined;`
- Add: `if (hasAttachment) { attachment = getAttachmentById(db, attachmentId); if (!attachment || attachment.uploader_id !== state.userId || attachment.message_id !== null) return; }`
- (Import `AttachmentRow` type from `../types.js` if a local annotation is used; otherwise rely on inference.)

### Step 5: Insert + link atomically, then broadcast the embedded `message.create`
**File(s):** `server/src/ws/gateway.ts`
**Action:** modify
**Description:** Replace the current bare `insertMessage(..., attachmentId: null)` + `toPublicMessage(row, null)` broadcast. Wrap insert and link in one `db.transaction`: insert with the real `attachmentId` (or `null` when none), and when `hasAttachment` assert `linkAttachmentToMessage(db, attachmentId, row.id) === true`, throwing on `false` to roll back (concurrency backstop — no orphan row). After the transaction commits, re-read via `getMessageWithAttachment(db, messageId)` and broadcast `toPublicMessage(r.message, r.attachment)` with no `except` (sender still gets its echo).
**Diff shape:**
- Remove: the current `const row = insertMessage(...attachmentId: null)` and the `hub.broadcast({ ... toPublicMessage(row, null) })`.
- Add: a transaction that returns the inserted message id:
  ```
  const messageId = db.transaction(() => {
    const row = insertMessage(db, {
      channelId, authorId: state.userId!, content,
      attachmentId: hasAttachment ? attachmentId : null,
    });
    if (hasAttachment) {
      const linked = linkAttachmentToMessage(db, attachmentId, row.id);
      if (!linked) throw new Error("attachment link race"); // rolls back
    }
    return row.id;
  })();
  ```
- Add: `const result = getMessageWithAttachment(db, messageId);` (defensive `if (!result) return;`).
- Add: `hub.broadcast({ op: "message.create", d: { message: toPublicMessage(result.message, result.attachment) } });`
- Note: wrap the transaction call in `try/catch` so a thrown link-race throws-to-rollback and is swallowed as a silent reject (`return;`), consistent with the drop-frame policy — the socket stays alive.

### Step 6: Update the in-code comment that says attachment linking is deferred
**File(s):** `server/src/ws/gateway.ts`
**Action:** modify
**Description:** The comment "`attachmentId` is accepted on the wire but not yet linked here; the validate-and-link flow … arrives in story 003." is now stale. Replace with a one-line note describing the implemented validate/link/embed behavior.
**Diff shape:**
- Change: stale "arrives in story 003" comment → brief description of ownership + link-once validation and embedded broadcast.

### Step 7: Author the provided contract
**File(s):** `context/features/m3-images/story-003-message-attachment-gateway/contracts/message-attachment-flow.md`
**Action:** create
**Description:** Document for client stories 004/005: the `message.send` attachment rules (typing of `attachmentId`; ownership = `uploader_id === sender`; link-once = `message_id IS NULL`; content-optional-iff-attachment; max-length still applies); the silent-drop rejection policy and its trigger list; and the embedded-attachment shape on `message.create` and `GET /api/channels/:id/messages` (`PublicMessage.attachment: PublicAttachment | null`, structurally identical live vs history, dedupe by `id`).
**Diff shape:**
- Add: `#contract` header, message.send input contract, rejection list, success/broadcast shape, history-parity note, link to story-001's `PublicAttachment`/`PublicMessage` shapes.

## New Types / Schemas / Contracts
No new TypeScript types or schema changes. `MessageSendPayload.attachmentId?: number | null` (already declared in `types.ts`) becomes semantically honored. The wire shapes (`PublicMessage`, `PublicAttachment`) are unchanged from story 001 and are restated authoritatively in the new contract for downstream client stories.

## Configuration / Environment Changes
None. `config.maxMessageLength` (M2) is reused unchanged. No new env vars, config keys, or persisted fields.

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| WS in | `message.send` | `{ channelId: number, content: string, attachmentId?: number \| null }` | (none; triggers broadcast) | `attachmentId` now honored; absent/null = plain text. Invalid id, foreign uploader, or already-linked → silently dropped, no persist. |
| WS out | `message.create` | (broadcast) | `{ message: PublicMessage }` where `PublicMessage.attachment` is the embedded `PublicAttachment` for image messages, else `null` | Broadcast to all sockets incl. sender; structurally identical to history. |
| REST out | `GET /api/channels/:id/messages` | (unchanged) | each `PublicMessage` already embeds `attachment` via story 001's LEFT JOIN | No change — parity already in place. |

## Edge Cases & Gotchas
- Image-only message (`content` empty/whitespace + valid attachment) is accepted — Step 3.
- Neither non-empty content nor a valid attachment → rejected — Step 3.
- `content` over `maxMessageLength` rejected even with an attachment — Step 3.
- `attachmentId` present but not a finite positive integer (string, float, 0, negative, NaN) → rejected — Step 2.
- Attachment does not exist / `uploader_id !== sender` / already linked (`message_id !== null`) → rejected, no row persisted — Step 4.
- Concurrent double-link race: pre-validation passes for two sends, but `linkAttachmentToMessage` returns `false` for the loser inside the transaction → throw rolls back the inserted message, so no orphan message row — Step 5.
- No-attachment path is byte-for-byte M2 behavior (`attachmentId: null`, `toPublicMessage(row, null)`) — Steps 2/5 (no regression).
- Sender still receives its own `message.create` echo (no `except` on broadcast) — Step 5.
- Frame/envelope/JSON/size guards and the auth gate are untouched — preserved from M2.

## Acceptance Criteria Checklist
- [ ] `message.send` honors `attachmentId`: loads via `getAttachmentById`, validates exists + `uploader_id === sender` + `message_id IS NULL`, rejects without persisting on failure → Steps 2, 4, 5
- [ ] On success persists message with `attachment_id` set, calls `linkAttachmentToMessage` atomically (one transaction), broadcasts `message.create` embedding the `attachment` → Steps 1, 5
- [ ] Content may be empty iff a valid attachment is attached; neither → rejected; max-length still applies → Step 3
- [ ] `message.send` with no `attachmentId` behaves exactly as M2 (`attachment: null`), no regression → Steps 2, 5
- [ ] History endpoint returns the embedded attachment so live + reloaded are structurally identical and dedupe by `id` → no change needed (story 001 LEFT JOIN); documented in Step 7
- [ ] `npm run typecheck` passes; verifiable end-to-end via `wscat`/`websocat` → Steps 1–6 (typed, ESM `.js` specifiers)
- [ ] `contracts/message-attachment-flow.md` documents the rules and embedded shape for stories 004/005 → Step 7
