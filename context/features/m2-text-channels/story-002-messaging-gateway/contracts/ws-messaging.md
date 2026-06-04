#contract

# Contract: WS gateway — messaging & broadcasts (story 002)

Authoritative interface for the realtime messaging additions to the M1 WebSocket gateway. Story 003
(REST channel route) emits `channel.create` through the helper documented here; stories 004 (channel
list) and 005 (message pane) consume `ready.channels`, `message.create`, and `channel.create` and send
`message.send`. Envelope and op names are `SPEC.md §7`; persistence is the story-001 data layer
(`contracts/channels-data.md`).

All frames use the generic `{ "op": string, "d": object }` envelope. The gateway path is `/ws`. Only
sockets that completed the M1 `identify` handshake may send `message.send` and only such sockets
receive `message.create` / `channel.create`.

## Ops

| Op               | Direction      | `d` payload                                                      |
| ---------------- | -------------- | ---------------------------------------------------------------- |
| `message.send`   | client→server  | `{ channelId: number, content: string, attachmentId?: number \| null }` |
| `message.create` | server→client  | `{ message: PublicMessage }`                                     |
| `channel.create` | server→client  | `{ channel: PublicChannel }`                                     |
| `ready` (changed)| server→client  | `{ user: PublicUser, channels: PublicChannel[], members: Member[] }` |

`PublicMessage` / `PublicChannel` / `PublicUser` / `Member` are the existing story-001 / M1 shapes (see
`contracts/channels-data.md` and `server/src/types.ts`). Timestamps are epoch ms. `attachmentId` is
always `null` in M2 on emitted messages.

### TypeScript payload types (`server/src/types.ts`)

```ts
// client→server — op "message.send" (attachmentId accepted on the wire but IGNORED in M2, stored NULL)
interface MessageSendPayload {
  channelId: number;
  content: string;
  attachmentId?: number | null;
}

// server→client — op "message.create"
interface MessageCreatePayload {
  message: PublicMessage;
}

// server→client — op "channel.create" (emitted by story-003 POST /api/channels via app.broadcast)
interface ChannelCreatePayload {
  channel: PublicChannel;
}

// ready.channels changed from never[] (M1 placeholder) to PublicChannel[]
interface ReadyPayload {
  user: PublicUser;
  channels: PublicChannel[];
  members: Member[];
}
```

The discriminated unions are extended accordingly:

```ts
type ServerEvent =
  | Envelope<"ready", ReadyPayload>
  | Envelope<"presence.update", PresenceUpdatePayload>
  | Envelope<"message.create", MessageCreatePayload>
  | Envelope<"channel.create", ChannelCreatePayload>;

type ClientCommand =
  | Envelope<"identify", IdentifyPayload>
  | Envelope<"message.send", MessageSendPayload>;
```

## `ready.channels` (changed)

On a successful `identify`, the `ready` snapshot now populates `channels` with
`listChannels(db).map(toPublicChannel)` (was an empty `[]` placeholder in M1). Ordered by `position`
then `id`. `user`, `members`, and the auth handshake are unchanged.

## `message.send` semantics

An authed socket sends `{ op: "message.send", d: { channelId, content, attachmentId? } }`. The gateway:

1. Validates `d` is a non-null object; `channelId` is a finite `number`; `content` is a `string` that is
   non-empty after `.trim()` and whose length is `<= config.maxMessageLength` (`MAX_MESSAGE_LENGTH`,
   default `4000`); and the channel exists (`getChannelById(db, channelId)`).
2. `attachmentId` is read but **ignored** — never validated, never persisted (stored `NULL` in M2).
3. Persists with `insertMessage(db, { channelId, authorId, content, attachmentId: null })` where
   `authorId` is the authenticated socket's user. `content` is stored exactly as sent (trim is
   validation-only).
4. Broadcasts `{ op: "message.create", d: { message: toPublicMessage(row) } }` to **all** authed sockets,
   **including the sender** (no `except`) so the sender renders the authoritative server row and can
   dedupe by `message.id`.

There is no direct ack/response to `message.send` — the `message.create` broadcast is the only effect.

### Error / validation policy

Invalid `message.send` is **silently ignored**: a malformed/non-JSON frame, non-object `d`, missing or
non-finite `channelId`, non-string / empty / whitespace-only / oversized `content`, or an unknown
`channelId` all cause the gateway to `return` — **no row is persisted, no broadcast is sent, and the
socket is never closed**. Unknown post-auth ops (including a second `identify`) are likewise ignored.
Inbound frames remain size-limited to 64 KiB (M1). Pre-auth sockets cannot send `message.send` — only
`identify` is honored before the handshake completes. There is no error envelope op.

## Broadcast helper (`app.broadcast`)

A flat, all-sockets broadcast hub backs a Fastify decoration so sibling plugins (the story-003 REST
layer) can push events to every connected client without touching gateway/presence internals:

```ts
// decorated on the Fastify instance in buildApp
interface FastifyInstance {
  broadcast: (env: Envelope, except?: WebSocket) => void;
}
```

- Serializes `env` once and sends to every authed socket whose `readyState` is OPEN, skipping `except`.
- `except` is optional; omit it to echo to all (as `message.create` does). `message.create` and
  `channel.create` are always sent with **no `except`**.
- Backed by `BroadcastHub` (`server/src/ws/hub.ts`), constructed once in `buildApp` and shared with the
  gateway (which `add`s each socket on `identify` and `remove`s it on disconnect). The hub is keyed only
  by socket — it does not expose the presence `Map<userId, …>`.

### Usage for story 003 (`POST /api/channels`)

After `createChannel(db, …)` returns the new `ChannelRow`, emit it live to everyone:

```ts
app.broadcast({ op: "channel.create", d: { channel: toPublicChannel(row) } });
```

(Use `request.server.broadcast` inside a handler.) This story provides the helper and the
`channel.create` payload shape only; the route itself is story 003.

## Delivery guarantees

- Live `message.create` / `channel.create` reach only currently-connected authed sockets. A client that
  was offline when a message/channel was created recovers it via `ready.channels` on connect and (for
  messages) the story-003 history fetch — not via a replayed live broadcast.
- All accessors use the shared `app.db` handle; no second SQLite connection is opened.
