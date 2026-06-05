#contract

# Contract: Message attachment flow (story 003)

Authoritative interface for sending an image-bearing message over the WS gateway and
receiving it back as a broadcast / in history. Client stories 004 (compose/upload) and
005 (render) consume exactly what is documented here. Builds on story 001's
`PublicAttachment` / `PublicMessage` shapes (`contracts/attachments-data.md`) and story
002's upload endpoint (which mints the `attachmentId`).

All WS frames are JSON `{ "op": string, "d": object }` envelopes (`SPEC.md §7`). The
gateway is reached at `GET /ws`; a socket must complete `identify` before any
`message.send` is honored.

## `message.send` (client → server)

```jsonc
{
  "op": "message.send",
  "d": {
    "channelId": 1,          // number, finite — an existing channel id
    "content": "hi",         // string — see content rule below
    "attachmentId": 7        // optional: number | null | absent — see typing below
  }
}
```

### Field rules

- **`channelId`** — required; must be a finite `number` and resolve to an existing
  channel. Otherwise the frame is dropped.
- **`content`** — required `string`. Must be ≤ `MAX_MESSAGE_LENGTH` (M2
  `config.maxMessageLength`); over-length is always rejected, even with an attachment.
- **`attachmentId`** — optional. Accepted forms:
  - **absent / `null` / `undefined`** → plain-text message, no attachment (byte-for-byte
    the M2 behavior; the broadcast carries `attachment: null`).
  - **a positive integer** (`Number.isInteger && > 0`) → attach that uploaded image.
  - **anything else present** (string, float, `0`, negative, `NaN`) → frame dropped.

### Content rule (relaxed from M2)

`content` may be empty or whitespace-only **iff** a valid `attachmentId` is attached
(image-only message). A `message.send` with **neither** non-empty content **nor** a valid
attachment is rejected. The max-length cap on `content` still applies in all cases.

### Attachment validation (when `attachmentId` is present)

The attachment is loaded via story 001's `getAttachmentById` and must satisfy **all** of:

1. **Exists** — the row is present.
2. **Ownership** — `uploader_id === sender.id` (the authed socket's user). You cannot
   attach another user's upload.
3. **Unlinked (link-once)** — `message_id IS NULL`. An attachment links to **at most one**
   message, ever; a reused `attachmentId` is rejected.

On success the message is inserted with `attachment_id` set and the attachment is linked
(`attachments.message_id = <new message id>`) **atomically in one transaction**. A
concurrent double-link loses the link-once race inside the transaction and rolls back, so
no orphan message row is persisted.

### Rejection policy (silent drop)

Any failed `message.send` is **silently ignored**: the offending frame is dropped, **no
message row is persisted**, **no attachment is linked**, and the socket stays open. There
is **no error op** — clients must not wait for one. Reject triggers:

- malformed envelope / non-string `op` / non-object `d`;
- missing/invalid `channelId`, or channel does not exist;
- non-string `content`, or `content` over `MAX_MESSAGE_LENGTH`;
- empty/whitespace `content` **and** no valid attachment;
- `attachmentId` present but not a positive integer;
- attachment does not exist, is owned by a different user, or is already linked;
- a concurrent link-once race on the attachment.

## `message.create` (server → all clients, incl. sender)

On a successful `message.send`, the gateway broadcasts to **every** connected socket
(the sender included — it gets its own echo):

```jsonc
{
  "op": "message.create",
  "d": {
    "message": {
      "id": 42,
      "channelId": 1,
      "authorId": 3,
      "content": "",          // may be empty for an image-only message
      "attachment": {          // PublicAttachment, or null for a plain-text message
        "id": 7,
        "messageId": 42,       // now set to this message's id
        "filename": "cat.png",
        "contentType": "image/png",
        "size": 18432,
        "width": 240,
        "height": 240,
        "createdAt": 1733280000000
      },
      "createdAt": 1733280000123
    }
  }
}
```

`message.attachment` is a `PublicAttachment` (story 001) when the message carries an
image, otherwise `null`. There is **no baked URL** — the client fetches the bytes from
`GET /api/attachments/:id` (Bearer auth) using `attachment.id`.

## History parity

`GET /api/channels/:id/messages` (M2 REST, story 001 read-side) embeds the **same**
`attachment` object per message via the same `LEFT JOIN`. A live `message.create` and the
same message reloaded from history are **structurally identical** and share the same `id`,
so clients **dedupe by `message.id`** when merging the live stream into loaded history.

## Stable shapes (restated from story 001)

```ts
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

interface PublicMessage {
  id: number;
  channelId: number;
  authorId: number;
  content: string;
  attachment: PublicAttachment | null;
  createdAt: number; // epoch ms
}
```
