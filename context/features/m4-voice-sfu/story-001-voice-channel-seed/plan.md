#plan

# Plan: Server — seed & expose the single voice channel

## Summary
Add an idempotent `seedVoiceChannel(db)` helper plus a typed `getVoiceChannel(db)` lookup to `server/src/channels.ts`, and call the seeder once during `buildApp` (right after the db is opened/decorated) so exactly one `type:"voice"` channel exists on boot and flows through the existing `listChannels → toPublicChannel` read path into `ready.channels`. No gateway, types, or create-route changes are needed; the only edits are `channels.ts`, `app.ts`, and a new `contracts/voice-channel.md`.

Decisions resolved from research (all "Decisions Made", no open questions): seeding lives in `channels.ts` and is invoked from `buildApp` (not `openDatabase`, to avoid the CLI silently seeding); idempotency is a `WHERE type='voice'` existence check (no schema/UNIQUE-index change); the seeded row uses name `"Voice"` (fixed literal — cosmetic, not contract-bound; not made configurable since no env wiring exists for it), `created_by = null` ("null reserved for future system-seeded channels"), and `position = nextChannelPosition(db)`.

## Implementation Steps

### Step 1: Add `getVoiceChannel` + `seedVoiceChannel` accessors
**File(s):** `server/src/channels.ts`
**Action:** modify
**Description:** Append two `db`-first accessors next to `createChannel`/`nextChannelPosition`/`listChannels`, mirroring the existing JSDoc + `.prepare(...).get/run(...)` style. `getVoiceChannel(db)` is both the AC-4 typed lookup and the story-003 single-room resolver; `seedVoiceChannel(db)` is the idempotent boot seed. `seedVoiceChannel` reuses `getVoiceChannel`, `createChannel`, and `nextChannelPosition` — it writes no hand-rolled INSERT SQL. The seed is wrapped in `db.transaction(...)` so the check-then-insert is atomic (matches the `db.transaction(...)` pattern available per `cli.ts`), guarding against a concurrent second boot writer even though boot is effectively single-writer.
**Diff shape:**
- Add: `export function getVoiceChannel(db: Db): ChannelRow | undefined` — `SELECT * FROM channels WHERE type = 'voice' ORDER BY position, id LIMIT 1` cast to `ChannelRow | undefined`. JSDoc: "Returns the single seeded voice channel (the v1 single-room invariant guarantees at most one), or `undefined` before seeding."
- Add: `export function seedVoiceChannel(db: Db): ChannelRow` — idempotent: returns the existing voice row if `getVoiceChannel(db)` is defined; otherwise `createChannel(db, { name: "Voice", type: "voice", position: nextChannelPosition(db), createdBy: null })`. Wrap the existence-check + insert in `db.transaction(() => { ... })()` so it is atomic. JSDoc: documents the CREATE-if-absent guarantee ("a restart does not create a second one") and that it always returns the canonical voice row.
- Remove: nothing.
- Change: nothing in existing functions.

### Step 2: Seed the voice channel during app construction
**File(s):** `server/src/app.ts`
**Action:** modify
**Description:** Call `seedVoiceChannel(db)` once inside `buildApp`, immediately after `app.decorate("db", db)` (and before the route/gateway plugins register), so the voice row exists prior to any client connecting and any `ready` snapshot being built. Add the import alongside the existing imports.
**Diff shape:**
- Add: `import { seedVoiceChannel } from "./channels.js";` near the other server-module imports.
- Add: a `seedVoiceChannel(db);` call (with a short comment: "Seed the single v1 voice channel idempotently — SPEC.md §13.3; reseeding on restart is a no-op.") right after `app.decorate("db", db);` / the `onClose` hook, before `app.register(channelRoutes, ...)` and `app.register(wsGateway, ...)`.
- Remove: nothing.
- Change: nothing else; do NOT touch `openDatabase`, the create route, the gateway, or `types.ts`.

### Step 3: Write the `provides_contract` doc
**File(s):** `context/features/m4-voice-sfu/story-001-voice-channel-seed/contracts/voice-channel.md`
**Action:** create
**Description:** Record the single-voice-channel contract for downstream stories 003 (voice gateway / room resolution) and 005 (client voice UI), following the structure of `m2-text-channels/.../contracts/channels-data.md`. Document: the identity of the single voice channel (`channels` row with `type = 'voice'`, name `"Voice"`, `created_by = null`), the "exactly one exists after boot, idempotent across restarts" guarantee, the new `getVoiceChannel`/`seedVoiceChannel` accessor signatures, the unchanged `PublicChannel` shape it takes in `ready.channels` (`type:"voice"`), and the preserved M2 invariant that `POST /api/channels` still rejects `type:"voice"`.
**Diff shape:**
- Add: the full contract markdown (see "New Types / Schemas / Contracts" + "API / Interface Changes" below for the authoritative content).
- Remove: nothing.
- Change: nothing.

### Step 4: Typecheck gate
**File(s):** none (verification only)
**Action:** n/a
**Description:** Run `npm run typecheck` (the only configured static gate) and confirm it passes. Optionally smoke-test by booting the server twice and confirming `ready.channels` / the channel list contains exactly one `type:"voice"` entry after restarts (AC 5).

## New Types / Schemas / Contracts

No new TypeScript types or DB columns are introduced — `ChannelRow`/`PublicChannel` and the `channels` table already carry `type: "text" | "voice"`. The new surface is two accessor functions and one invariant, recorded in `contracts/voice-channel.md`:

```ts
// server/src/channels.ts (new exports)

/** Returns the single seeded voice channel, or `undefined` before seeding. */
export function getVoiceChannel(db: Db): ChannelRow | undefined;

/**
 * Idempotently ensures exactly one `type:"voice"` channel exists and returns it.
 * CREATE-if-absent: a restart finds the existing row and inserts nothing.
 * Seeded row: { name: "Voice", type: "voice", createdBy: null,
 *               position: nextChannelPosition(db) }.
 */
export function seedVoiceChannel(db: Db): ChannelRow;
```

Invariant exposed to stories 003/005:
```
Single-voice-channel invariant (v1, SPEC.md §13.3):
  - After buildApp boot, exactly one channels row has type = 'voice'.
  - getVoiceChannel(db) resolves that row (the single SFU room id).
  - Idempotent across restarts; never user-created (POST /api/channels rejects voice).
  - Appears in ready.channels as PublicChannel{ type: "voice", createdBy: null, name: "Voice", ... }.
```

## Configuration / Environment Changes
None. The seeded channel name is a fixed literal `"Voice"` (cosmetic, no contract or SPEC constraint, and no existing env-wiring pattern for channel names), so no new `loadConfig()` field or `.env.example` entry is added. No new persisted columns — the `channels` table and its `type` discriminator already exist.

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| Public function | `getVoiceChannel(db)` | `db: Db` | `ChannelRow \| undefined` | New accessor in `channels.ts`; the single-room resolver + AC-4 typed lookup |
| Public function | `seedVoiceChannel(db)` | `db: Db` | `ChannelRow` (the canonical voice row) | New idempotent boot seeder; called once from `buildApp` |
| WS `ready` (unchanged wire) | `ready.channels[]` | — | now always includes one `PublicChannel` with `type:"voice"` | No gateway/type code change; flows via `listChannels → toPublicChannel` |
| REST (unchanged) | `POST /api/channels` | `{ name, type:"text" }` | 201 `PublicChannel` | Still rejects `type:"voice"` via the `enum:["text"]` schema — intentionally untouched (AC 3) |
| REST (unchanged) | `GET /api/channels/:id/messages` | — | message page | `getChannelById` now also resolves the voice channel id generically; no behavioral change required by this story |

## Edge Cases & Gotchas

- Restart must not create a second voice channel — handled in Step 1 (`getVoiceChannel` existence check before insert; idempotent return).
- Concurrent/double seeding (defensive) — handled in Step 1 (`db.transaction(...)` wraps check-then-insert atomically).
- Seeding must not become a side effect of every `openDatabase` (CLI commands like `mint-token` open the db) — handled in Step 2 (seed from `buildApp`, not `openDatabase`/`applySchema`).
- Voice row must exist before the first `ready` snapshot — handled in Step 2 (seed call placed before `channelRoutes`/`wsGateway` registration).
- M2 "voice not user-creatable" invariant must stay intact — handled by NOT editing `routes/channels.ts` (its `enum:["text"]` guard remains); called out in Steps 2 & 3 (AC 3).
- Position ordering: the voice channel must sort consistently with text channels — handled in Step 1 via `nextChannelPosition(db)`, matching `listChannels`' `ORDER BY position, id`.
- `created_by` for a system-seeded channel — handled in Step 1 using `null` (FK is nullable; "null reserved for future system-seeded channels").
- ESM `.js` import specifier for the new `seedVoiceChannel` import — handled in Step 2 (`from "./channels.js"`).

## Acceptance Criteria Checklist

- [ ] On server boot, exactly one `type:"voice"` channel is seeded idempotently (CREATE-if-absent; restart does not duplicate); name + seeding in a clear place (`seedVoiceChannel(db)` reachable from `buildApp`, reusing `channels.ts` helpers) → Step 1, Step 2
- [ ] The seeded voice channel is returned in `ready.channels` with `type:"voice"` via existing `listChannels → toPublicChannel`, no gateway change → Step 2 (seed exists before `ready`); verified in Step 4
- [ ] M2 invariants preserved: `POST /api/channels` still rejects `type:"voice"`; duplicate-name rules unchanged → Step 2 (no edit to `routes/channels.ts`), documented Step 3
- [ ] `getChannelById` / channel lookups distinguish `text` vs `voice` so a later story can validate `voice.join` targets a voice channel → Step 1 (`getVoiceChannel`; `getChannelById(...).type` already discriminates)
- [ ] `npm run typecheck` passes; channel list / `ready` shows the voice channel present once after one or more restarts → Step 4
- [ ] `contracts/voice-channel.md` records identity (`type:"voice"` row, single-room invariant), its `ready.channels` shape, and the exactly-one guarantee for stories 003 & 005 → Step 3
