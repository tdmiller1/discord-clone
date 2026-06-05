#research

# Research: Gateway — link attachmentId on message.send & embed attachment in broadcasts

## Files to Touch

### Likely Modified
- `server/src/ws/gateway.ts` — extend the `message.send` handler (lines ~200–224) to honor `attachmentId`: validate ownership/link-once, relax the content-required rule when a valid attachment is present, persist with `attachment_id` set, link, and broadcast the embedded attachment. This is the core of the story.

### Likely Created
- `context/features/m3-images/story-003-message-attachment-gateway/contracts/message-attachment-flow.md` — the contract this story `provides_contract`; documents the `message.send` attachment rules (ownership, link-once, content-optional-with-attachment) and the embedded-attachment shape on `message.create`/history for client stories 004/005.

### Read-Only Reference (patterns to follow)
- `server/src/attachments.ts` — `getAttachmentById` (existence check + `uploader_id`/`message_id` inspection) and `linkAttachmentToMessage` (link-once `WHERE message_id IS NULL`, returns boolean). Both already take `db` first.
- `server/src/channels.ts` — `insertMessage` (now accepts a real `attachmentId`), `getMessageWithAttachment` (single-message LEFT JOIN for the broadcast read), `getChannelById`. Note `db.transaction(() => {...})()` usage in `seedVoiceChannel` — the model for an atomic insert+link.
- `server/src/types.ts` — `toPublicMessage(row, attachment)` two-arg mapper, `MessageSendPayload` (`attachmentId?: number | null`), `PublicMessage.attachment`, `PublicAttachment`.
- `server/src/ws/hub.ts` — `hub.broadcast(env, except?)` for the `message.create` fan-out (sender included, no `except`).
- Upstream contract: `context/features/m3-images/story-001-attachments-data/contracts/attachments-data.md` — authoritative for accessor signatures and the §"Usage notes for 002/003" link recipe.

## Existing Patterns

The post-auth `message.send` block in `gateway.ts` (lines 198–225) is the analogue to copy/extend. Current shape:

1. `if (op !== "message.send") return;` — every unknown op (and malformed frame) is **silently ignored**; there is no error op anywhere in the gateway today (`grep` confirms none). All rejection paths are bare `return;` (drop the frame, keep the socket alive).
2. Field extraction is hand-rolled, defensive: cast `d` to `object`, pull `channelId`/`content`, typecheck each (`typeof channelId !== "number" || !Number.isFinite(channelId)` → return; `typeof content !== "string"` → return).
3. Content validation: `const trimmed = content.trim(); if (trimmed.length === 0 || content.length > config.maxMessageLength) return;`
4. Channel existence: `if (!getChannelById(db, channelId)) return;`
5. `insertMessage(db, { channelId, authorId: state.userId!, content, attachmentId: null })`.
6. `hub.broadcast({ op: "message.create", d: { message: toPublicMessage(row, null) } });` (no `except` — sender gets its own echo).

Conventions: ESM `.js` import specifiers; `db` is `app.db` reached once at the top of the plugin (`const db = app.db;`); `state.userId!` is the authed sender id; rejection = `return;`. SQLite transactions via `db.transaction(fn)()` (synchronous, better-sqlite3).

## Data Flow

Client → `message.send { channelId, content, attachmentId? }` over WS → gateway `socket.on("message")` (post-auth branch) →
- extract + typecheck `channelId`, `content`, and now `attachmentId` (accept `number` finite, or `undefined`/`null`/absent = no attachment) →
- resolve `hasAttachment` and load `getAttachmentById(db, attachmentId)` when present →
- **validate:** attachment exists, `uploader_id === state.userId`, `message_id === null`; on failure → reject (drop frame, no persist) →
- **content rule:** require non-empty `trimmed` content **unless** a valid attachment is present; `content.length > maxMessageLength` still rejects either way →
- `getChannelById` existence check →
- **atomic insert+link** (`db.transaction`): `insertMessage(db, { ..., attachmentId })` then, if attached, `linkAttachmentToMessage(db, attachmentId, message.id)` — assert it returned `true` (re-validates link-once at commit; on `false`, the transaction should not commit a half-linked state) →
- re-read via `getMessageWithAttachment(db, message.id)` →
- `hub.broadcast({ op: "message.create", d: { message: toPublicMessage(r.message, r.attachment) } })`.

History parity is already in place: `GET /api/channels/:id/messages` uses `getChannelMessages` (LEFT JOIN) mapped with `toPublicMessage(r.message, r.attachment)`, so live + reloaded messages are structurally identical and dedupe by `id`. No change needed on the history side.

## Decisions Made

1. **Reject = silently drop the frame (`return;`), matching M2.** The story permits "defined error op **or** ignored"; the entire gateway has zero error-op precedent and every M2 invalid-`message.send` path is a bare `return;`. Introducing an error op would be a new protocol surface with no consumer (clients 004/005 are not told to expect one). Follow the established ignore-and-keep-socket-alive policy; the contract documents the rejection list explicitly.

2. **Persist `attachment_id` on the message row AND set `attachments.message_id`.** The story criterion says "persists the message with `attachment_id` set"; pass the real `attachmentId` to `insertMessage` (not `null`), then call `linkAttachmentToMessage`. The contract notes the attachment's `message_id` is the authoritative link, but the messages FK column carries the value too so the existing `getMessageWithAttachment` LEFT JOIN (`a.id = m.attachment_id`) resolves the embed. (The story-001 contract's §"Usage notes" suggested `insertMessage(..., attachmentId: null)`; the **story-003 acceptance criterion explicitly requires `attachment_id` set on the message**, and `getMessageWithAttachment` joins on `m.attachment_id`, so the column must be set — this is the binding requirement.)

3. **Wrap insert+link in one `db.transaction(...)()`.** The story asks for atomicity ("one transaction"). `linkAttachmentToMessage` returning `false` inside the transaction (e.g. a concurrent link) throws to roll back, so no orphan message row persists. better-sqlite3 transactions are synchronous, matching the existing `seedVoiceChannel` pattern.

4. **Pre-validate the attachment with `getAttachmentById` before opening the transaction** (existence, `uploader_id === state.userId`, `message_id === null`), per the story-001 contract: `linkAttachmentToMessage` does not check ownership/existence. The in-transaction `linkAttachmentToMessage === true` assertion is the concurrency backstop.

5. **`attachmentId` typing:** accept absent / `null` / a finite positive `number`. Anything else present-but-not-a-number → reject. No-attachment path is byte-for-byte the M2 behavior (`toPublicMessage(row, null)`), satisfying the no-regression criterion.
