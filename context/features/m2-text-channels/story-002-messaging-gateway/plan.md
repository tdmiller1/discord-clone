#plan

# Plan: WS gateway — message.send, broadcasts & ready.channels

## Summary
Extend the M1 WebSocket gateway so authed sockets can send `message.send` (validated, persisted via story-001 `insertMessage`, broadcast as `message.create` to everyone including the sender), populate `ready.channels` from `listChannels`, and expose a reusable flat broadcast hub on `app` so the story-003 REST layer can emit `channel.create`. Resolved open question (research Decision 3): the `message.send` validation+persist is **inlined** in the gateway's message handler (like `identify`) rather than extracted to a `messaging.ts` module — the logic is ~10 lines with a single caller, matches the existing inline style, and there is no test runner that would benefit from an isolated unit. A new `server/src/ws/hub.ts` (research Decision 1) is the only new source file, required because there is no `fastify-plugin` so a hub decorated *inside* the gateway plugin would be invisible to the sibling REST plugin.

## Implementation Steps

### Step 1: Add the new WS message types to `types.ts`
**File(s):** `server/src/types.ts`
**Action:** modify
**Description:** Replace the `ReadyPayload.channels` placeholder type and add the three new envelope payloads plus their entries in the `ServerEvent` / `ClientCommand` unions. `PublicChannel` / `PublicMessage` and their mappers already exist (story 001), so no new mappers.
**Diff shape:**
- Change: `ReadyPayload.channels` from `never[]` to `PublicChannel[]` (drop the "becomes PublicChannel[] in story 002" comment).
- Add: `MessageSendPayload { channelId: number; content: string; attachmentId?: number | null }` (client→server; `attachmentId` ignored in M2).
- Add: `MessageCreatePayload { message: PublicMessage }` (server→client).
- Add: `ChannelCreatePayload { channel: PublicChannel }` (server→client).
- Change: extend `ServerEvent` union with `| Envelope<"message.create", MessageCreatePayload> | Envelope<"channel.create", ChannelCreatePayload>`.
- Change: extend `ClientCommand` union with `| Envelope<"message.send", MessageSendPayload>`.

### Step 2: Create the flat broadcast hub
**File(s):** `server/src/ws/hub.ts`
**Action:** create
**Description:** A small framework-agnostic `BroadcastHub` owning a `Set<WebSocket>` of all authed sockets, mirroring `PresenceRegistry.broadcast` (serialize once, loop, skip `except`, guard `readyState === OPEN`). This is the "reusable broadcast helper" the AC requires; it is keyed only by socket (not by user) so the REST layer never touches presence internals. It is constructed at `buildApp` level (Step 4) and shared with both the gateway and the future story-003 routes.
**Diff shape:**
- Add: `import type { WebSocket } from "@fastify/websocket";` and `import type { Envelope } from "../types.js";`.
- Add: `export class BroadcastHub` with a private `#sockets = new Set<WebSocket>()`.
- Add: `add(socket: WebSocket): void` and `remove(socket: WebSocket): void` (idempotent — `Set` semantics; `remove` may fire on both `close` and `error`).
- Add: `broadcast = (env: Envelope, except?: WebSocket): void => { const payload = JSON.stringify(env); for (const socket of this.#sockets) { if (socket === except) continue; if (socket.readyState === socket.OPEN) socket.send(payload); } }` — defined as an arrow/bound method so `app.decorate("broadcast", hub.broadcast)` keeps `this`.

### Step 3: Wire the hub into the gateway and populate `ready.channels` + handle `message.send`
**File(s):** `server/src/ws/gateway.ts`
**Action:** modify
**Description:** Accept the shared hub via plugin options, register/deregister each authed socket in it alongside `registry.add`/`registry.remove`, populate `buildReady`'s channels, and add the `message.send` branch in the post-auth region. Stop ignoring `config` (the param is currently `_opts`).
**Diff shape:**
- Change: `WsGatewayOptions` to `{ config: Config; hub: BroadcastHub }`; import `BroadcastHub` from `./hub.js`.
- Change: signature `(app, _opts)` → `(app, opts)`; destructure `const { config, hub } = opts;` (`config.maxMessageLength` is now read).
- Add: imports `listChannels`, `getChannelById`, `insertMessage` from `../channels.js`, and `toPublicChannel`, `toPublicMessage` (already-exported mappers) + `PublicChannel`, `PublicMessage` types from `../types.js`.
- Change: `buildReady` returns `channels: listChannels(db).map(toPublicChannel)` instead of `channels: []`. `members` and the handshake are untouched.
- Change: after a successful `identify` (where `registry.add` is called), also call `hub.add(socket)` so the socket receives `message.create` / `channel.create` broadcasts.
- Change: in `teardown`, call `hub.remove(socket)` alongside `registry.remove` (place it unconditionally so a socket that authed but is mid-teardown is always removed; `hub.remove` is idempotent).
- Change: replace the post-auth no-op comment with a `message.send` branch:
  - `if (op !== "message.send") return;` (unknown post-auth ops, incl. a second `identify`, still ignored).
  - Read `const d = (frame as { d?: unknown }).d;` guard `typeof d === "object" && d !== null` else `return`.
  - Narrow `channelId`: `typeof === "number" && Number.isFinite(channelId)` else `return`.
  - Narrow `content`: `typeof === "string"`; compute `const trimmed = content.trim();` `return` if `trimmed.length === 0` or `content.length > config.maxMessageLength`.
  - `attachmentId` is read off `d` but never validated or used.
  - Channel existence: `if (!getChannelById(db, channelId)) return;`.
  - Persist: `const row = insertMessage(db, { channelId, authorId: state.userId!, content, attachmentId: null });` (`state.userId` is non-null in the authed branch).
  - Broadcast (no `except`, so the sender gets its own echo): `hub.broadcast({ op: "message.create", d: { message: toPublicMessage(row) } });`.

### Step 4: Construct the hub in `buildApp`, decorate it on `app`, and thread it to the gateway
**File(s):** `server/src/app.ts`
**Action:** modify
**Description:** Build the single shared `BroadcastHub` at app level (so it is visible to both plugins), decorate `app.broadcast` for the story-003 REST layer, and pass the hub into `wsGateway` via register options — mirroring the existing `app.decorate("db", db)` + `app.register(plugin, { config })` patterns.
**Diff shape:**
- Add: `import { BroadcastHub } from "./ws/hub.js";` and `import type { Envelope } from "./types.js";`.
- Add: in the `declare module "fastify"` block, `broadcast: (env: Envelope, except?: import("@fastify/websocket").WebSocket) => void;` on `FastifyInstance` (so `app.broadcast` / `request.server.broadcast` is typed for story 003).
- Add: after `const db = openDatabase(config)` / `app.decorate("db", db)`, construct `const hub = new BroadcastHub();` and `app.decorate("broadcast", hub.broadcast);`.
- Change: `app.register(wsGateway, { config })` → `app.register(wsGateway, { config, hub })`.

### Step 5: Author the `ws-messaging.md` contract
**File(s):** `context/features/m2-text-channels/story-002-messaging-gateway/contracts/ws-messaging.md`
**Action:** create
**Description:** Document the `message.send` / `message.create` / `channel.create` payloads, the `ready.channels` addition, the echo-to-sender broadcast semantics, the silent-ignore error policy, and the `app.broadcast` helper API — the authoritative interface for story 003 (server) and stories 004–005 (client). Mirrors the `contracts/channels-data.md` format from story 001 (`#contract` header, envelope/TS shapes, usage notes).
**Diff shape:**
- Add: envelope table for the three ops with direction (client→server / server→client) and `{ op, d }` shapes.
- Add: the `ready.channels: PublicChannel[]` change note (members/handshake unchanged).
- Add: `app.broadcast(env, except?)` helper signature + the note that `message.create`/`channel.create` broadcast to **all** sockets (no `except`, sender echoes its own row).
- Add: validation/error policy (unknown channel, empty/oversized/whitespace content, malformed envelope → silently ignored, never persisted, never broadcast, socket stays up; `attachmentId` ignored, stored NULL; only post-auth sockets may send).

## New Types / Schemas / Contracts

New TypeScript types in `server/src/types.ts`:

```ts
// client→server: op "message.send" (attachmentId ignored in M2, stored NULL)
interface MessageSendPayload {
  channelId: number;
  content: string;
  attachmentId?: number | null;
}

// server→client: op "message.create"
interface MessageCreatePayload {
  message: PublicMessage; // existing story-001 shape
}

// server→client: op "channel.create" (emitted by story-003 via app.broadcast)
interface ChannelCreatePayload {
  channel: PublicChannel; // existing story-001 shape
}

// ReadyPayload.channels: never[]  ->  PublicChannel[]

// ServerEvent union gains:
//   | Envelope<"message.create", MessageCreatePayload>
//   | Envelope<"channel.create", ChannelCreatePayload>
// ClientCommand union gains:
//   | Envelope<"message.send", MessageSendPayload>
```

New class in `server/src/ws/hub.ts`:

```ts
class BroadcastHub {
  add(socket: WebSocket): void;
  remove(socket: WebSocket): void;
  // serialize once, send to every OPEN socket, skip `except`
  broadcast: (env: Envelope, except?: WebSocket) => void;
}
```

New Fastify decoration (`app.ts` `declare module "fastify"`):

```ts
interface FastifyInstance {
  broadcast: (env: Envelope, except?: WebSocket) => void;
}
```

## Configuration / Environment Changes

None. All three M2 tunables (`maxMessageLength` / `MAX_MESSAGE_LENGTH` = 4000, `messageHistoryDefaultLimit`, `messageHistoryMaxLimit`) were registered in `config.ts` + `.env.example` by story 001. This story only **reads** `config.maxMessageLength` for `content` validation. No new persisted columns (story 001 created `channels` / `messages`).

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| WS op (client→server) | `message.send` | `{ op: "message.send", d: { channelId: number, content: string, attachmentId?: number\|null } }` | none directly; triggers a `message.create` broadcast | Authed sockets only. Validated: channel must exist, `content` non-empty after trim and `≤ maxMessageLength`. Invalid → silently ignored (no persist/broadcast, socket stays up). `attachmentId` ignored, stored NULL. |
| WS op (server→client) | `message.create` | — | `{ op: "message.create", d: { message: PublicMessage } }` | Broadcast to **all** authed sockets incl. the sender (echo). |
| WS op (server→client) | `channel.create` | — | `{ op: "channel.create", d: { channel: PublicChannel } }` | Emitted by story-003's `POST /api/channels` via `app.broadcast`; this story only provides the helper + payload shape. |
| WS op (server→client) | `ready` (modified) | — | `{ op: "ready", d: { user, channels: PublicChannel[], members } }` | `channels` now populated from `listChannels`; `user`/`members`/handshake unchanged. |
| Public fn | `app.broadcast(env, except?)` | `env: Envelope`, optional `except: WebSocket` | `void` | Decorated on the Fastify instance for cross-plugin use (story 003 REST emits `channel.create`). Serializes once, sends to every OPEN socket, skips `except`. |
| Public class | `BroadcastHub` (`server/src/ws/hub.ts`) | `add(socket)`, `remove(socket)`, `broadcast(env, except?)` | `void` | Flat all-sockets hub constructed once in `buildApp`; its `broadcast` backs `app.broadcast`. |

## Edge Cases & Gotchas

- Malformed envelope / non-object `d` / non-JSON frame → existing parse guards `return` before the `message.send` branch; never throws, never closes — Step 3.
- Unknown / nonexistent `channelId` (`getChannelById` returns `undefined`) → `return`, no persist, no broadcast — Step 3.
- Empty or whitespace-only `content` (`trimmed.length === 0`) → ignored; `content` is stored un-trimmed only if non-empty after trim (content itself is persisted as-sent per story 001 accessor; trim is validation-only) — Step 3.
- Oversized `content` (`content.length > config.maxMessageLength`) → ignored — Step 3.
- `attachmentId` supplied on `message.send` → read but never validated/used; persisted as `null` — Step 3.
- Non-finite / non-number `channelId` (e.g. `NaN`, string) → `Number.isFinite` guard `return`s — Step 3.
- Pre-auth socket sends `message.send` → falls in the `!state.authed` branch which only honors `identify`, so it is ignored; only post-auth sockets reach the `message.send` branch — Step 3.
- Sender must see its own message → `hub.broadcast` is called WITHOUT `except`, contrasting `presence.update` which passes the joining socket — Step 3.
- Cross-plugin visibility: a hub decorated *inside* the gateway plugin would be encapsulated/invisible to the REST plugin (no `fastify-plugin` in deps) → hub is constructed at `buildApp` level and decorated on `app` — Steps 2, 4.
- Hub leak on disconnect: `hub.remove(socket)` must run in `teardown` (fires on both `close` and `error`); `remove` is idempotent via `Set` so double-fire is safe — Steps 2, 3.
- `app.broadcast` `this` binding: `broadcast` is a bound/arrow method so `app.decorate("broadcast", hub.broadcast)` does not lose `this` — Step 2.
- Reconnect/persistence: a client offline when a message was created still gets it — not via the missed live `message.create`, but via story-003 history fetch + `ready.channels`; this story guarantees the live broadcast + populated channel list only — Steps 1, 3.
- `state.userId` is non-null in the authed branch (set on `identify`); use a non-null assertion when passing `authorId` — Step 3.
- ESM: all new relative imports carry the `.js` extension (`./hub.js`, `../channels.js`) — Steps 2, 3, 4.

## Acceptance Criteria Checklist

- [ ] `ready.channels` populated from `listChannels` as `PublicChannel[]`, replacing the empty placeholder; `members`/handshake unchanged → Step 1, Step 3
- [ ] Gateway handles `message.send { channelId, content, attachmentId? }`: validates channel exists + `content` non-empty (trimmed) + within max length; persists via `insertMessage` with `author_id` = authed user and `attachment_id = NULL`; broadcasts `message.create { message: PublicMessage }` → Step 1, Step 3
- [ ] `attachmentId` ignored (stored NULL); `content` still required → Step 3
- [ ] `message.create` / `channel.create` broadcast to **all** sockets incl. an echo to the sender → Step 2, Step 3 (message.create), Step 4 (channel.create helper)
- [ ] Reusable broadcast helper exposed on the hub / `app` for the REST layer to emit `channel.create` → Step 2, Step 4
- [ ] Invalid `message.send` ignored safely: never persists a bad row, never broadcasts, never tears down the socket; frames stay size-limited (M1); unknown ops ignored → Step 3
- [ ] All frames use the `{ op, d }` envelope; only post-auth sockets may send → Step 1, Step 3
- [ ] `npm run typecheck` passes; verifiable with two `wscat`/`websocat` clients (both get `ready` with channels; one's `message.send` → both get `message.create`) → Step 1, Step 2, Step 3, Step 4
- [ ] `contracts/ws-messaging.md` documents `message.send` / `message.create` / `channel.create`, the `ready.channels` addition, and the broadcast-helper API → Step 5
