#contract

# Contract: The single seeded voice channel (M4 story 001)

Authoritative interface for the v1 single voice channel. Stories 003 (voice gateway / room
resolution) and 005 (client voice UI) build on exactly what is documented here. The single-room
decision is `SPEC.md §13.3`; the channel data model is `SPEC.md §8`.

All server modules are ESM with `.js` import specifiers (e.g.
`import { getVoiceChannel } from "./channels.js"`). Files live under `server/src/`. Accessors use the
shared `Db` handle (`fastify.db` / the gateway db) — do **not** open a second connection.

## Single-voice-channel invariant (v1, SPEC.md §13.3)

- After `buildApp(config)` boots, **exactly one** `channels` row has `type = 'voice'`.
- The seeded row is `{ name: "Voice", type: "voice", created_by: null, position: nextChannelPosition(db) }`
  (`null` creator is reserved for system-seeded channels; `position` appends after existing text
  channels so it sorts consistently under `listChannels`' `ORDER BY position, id`). `id` and
  `created_at` are assigned by the insert (`created_at` is epoch ms).
- Seeding is **idempotent across restarts**: a restart finds the existing row and inserts nothing, so a
  second voice channel is never created. The check-then-insert is wrapped in a transaction.
- The voice channel is **never user-created**: `POST /api/channels` still rejects `type:"voice"` via
  its `type: { enum: ["text"] }` schema (M2 invariant preserved); duplicate-name rules are unchanged.
- `getVoiceChannel(db)` resolves that single row — use it as the SFU single-room resolver and as the
  typed `text` vs `voice` lookup (e.g. story 003 validating `voice.join` targets a voice channel).

## Where it is seeded

`seedVoiceChannel(db)` is called once inside `buildApp` (`server/src/app.ts`), immediately after the
db is opened and decorated and **before** the route/gateway plugins register — so the voice row exists
prior to any client connecting or any `ready` snapshot being built. It is **not** called from
`openDatabase`/`applySchema`, so CLI commands that open the db (e.g. `mint-token`) do not seed a voice
channel as a side effect.

## channels module API additions (`server/src/channels.ts`)

```ts
import type { Db } from "./db.js";
import type { ChannelRow } from "./types.js";

/**
 * Returns the single seeded voice channel (the v1 single-room invariant guarantees
 * at most one), or `undefined` before seeding. The typed voice lookup + single-room resolver.
 */
export function getVoiceChannel(db: Db): ChannelRow | undefined;

/**
 * Idempotently ensures exactly one `type:"voice"` channel exists and returns it (the
 * canonical voice row). CREATE-if-absent: a restart finds the existing row and inserts
 * nothing. Seeded row: { name: "Voice", type: "voice", createdBy: null, position: nextChannelPosition(db) }.
 */
export function seedVoiceChannel(db: Db): ChannelRow;
```

Both reuse existing `channels.ts` helpers (`createChannel`, `nextChannelPosition`); no hand-rolled
INSERT SQL and no schema/UNIQUE-index change is introduced.

## Shape in `ready.channels` (unchanged wire)

The voice channel flows into the WS `ready` snapshot via the existing
`listChannels(db).map(toPublicChannel)` path — **no gateway or `types.ts` change**. It appears as a
`PublicChannel` (camelCase, `server/src/types.ts`):

```ts
interface PublicChannel {
  id: number;
  name: string;          // "Voice"
  type: "text" | "voice"; // "voice" for the seeded row
  position: number;
  createdBy: number | null; // null for the seeded voice channel
  createdAt: number;        // epoch ms
}
```

So clients receive the voice channel with no gateway change; story 005 stops filtering `type:"voice"`
out and renders it. `GET /api/channels/:id/messages` and any `getChannelById` lookup also resolve the
voice channel id generically (no behavioral change required by this story).

## Usage notes for 003 / 005

- **Voice gateway (003):** resolve the single SFU room with `getVoiceChannel(db)`; validate that a
  `voice.join` targets a voice channel by checking the resolved channel's `type === "voice"` (e.g. via
  `getChannelById(db, id)?.type === "voice"` or that `id` equals `getVoiceChannel(db)?.id`).
- **Client voice UI (005):** the voice channel is present exactly once in `ready.channels` with
  `type:"voice"`, `name:"Voice"`, `createdBy:null`; render it as the (single) join-voice target.
- Reach the db via `fastify.db` (or the gateway's handle); never open a second connection.
