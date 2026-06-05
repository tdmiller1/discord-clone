#research

# Research: Server — seed & expose the single voice channel

## Files to Touch

### Likely Modified
- `server/src/channels.ts` — add a `seedVoiceChannel(db)` helper (and likely a `findVoiceChannel(db)` / `getVoiceChannel(db)` lookup) next to the existing `createChannel`/`getChannelById`/`listChannels` accessors. This is the "clear place" the AC asks for and reuses `createChannel` + `nextChannelPosition`.
- `server/src/app.ts` — call `seedVoiceChannel(db)` once right after `openDatabase(config)` / `applySchema` runs (i.e. after `app.decorate("db", db)`), so a single voice channel exists before the gateway serves any `ready` snapshot. This is the `buildApp`/startup hook the AC names.

### Likely Created
- `context/features/m4-voice-sfu/story-001-voice-channel-seed/contracts/voice-channel.md` — the `provides_contract` deliverable (frontmatter points to `contracts/voice-channel.md`). Records the single-voice-channel identity (`type:"voice"` row, single-room invariant), its `PublicChannel` shape in `ready.channels`, and the "exactly one exists" guarantee — consumed by stories 003 (voice gateway) and 005 (client voice UI).

### Read-Only Reference (patterns to follow)
- `server/src/channels.ts` — `createChannel(db, { name, type, position, createdBy })` returns the persisted `ChannelRow`; `nextChannelPosition(db)` computes `MAX(position)+1`; `listChannels(db)` orders by `position, id`. Copy the framework-agnostic `db`-first accessor shape and the JSDoc style.
- `server/src/cli.ts` — `mintToken` shows the idempotent / single-insert SQLite pattern (`db.prepare(...).run(...)`) and `db.transaction(...)` usage if an atomic check-then-insert is wanted.
- `server/src/routes/channels.ts` — `createChannelSchema` with `type: { enum: ["text"] }` is the existing guard that already rejects `voice`. Confirm the M2 invariant stays (AC 3) — no change needed, but it is the line that proves voice is not user-creatable.
- `server/src/ws/gateway.ts` `buildReady` — `channels = listChannels(db).map(toPublicChannel)` already emits every channel including `voice`, so the seeded channel flows into `ready.channels` with **no gateway change** (AC 2). Confirms nothing here needs editing.
- `context/features/m2-text-channels/story-001-channels-messages-schema/contracts/channels-data.md` — format/structure template for the contract file to write; documents the `channels` table, `ChannelRow`/`PublicChannel` shapes, and accessor signatures.

## Existing Patterns

**Channel persistence (`server/src/channels.ts`).** All accessors are framework-agnostic, take `Db` as the first arg, and `.prepare(...).run/get/all(...)` against the shared handle (no second connection). Writes re-`SELECT` the inserted row by `lastInsertRowid` and return the full `*Row` (see `createChannel`). `nextChannelPosition(db)` yields `MAX(position)+1` (or `0` when empty). The seed helper should mirror this: a `db`-first export with JSDoc, reusing `createChannel`/`nextChannelPosition` rather than hand-writing SQL.

**Idempotent setup.** `applySchema(db)` (`server/src/schema.ts`) is `CREATE TABLE/INDEX IF NOT EXISTS` and runs on every `openDatabase`. The CHECK constraint `type IN ('text','voice')` is already present and the `type: "text" | "voice"` discriminator exists end-to-end (`ChannelRow`, `PublicChannel`, `toPublicChannel`). There is currently **no row seeding of any kind** (`grep "INSERT INTO channels"` matches only `createChannel`; no "general"/default channel is seeded today). So `seedVoiceChannel` is a brand-new, additive concern — no existing seed to extend.

**Voice already flows through the read path unchanged.** `toPublicChannel` copies `type` verbatim; `buildReady` maps `listChannels(db)` straight into `ready.channels`; the REST history route uses `getChannelById` generically. The only place that filters/rejects `voice` is the **create** route's JSON schema enum. So exposure (AC 2) is free; the work is seeding (AC 1) + a typed voice lookup (AC 4) + the contract (AC 6).

**Idempotency mechanism.** The clean idempotent seed is: on boot, check `SELECT id FROM channels WHERE type = 'voice'` (or a new `getVoiceChannel(db)` accessor); if none, `createChannel(db, { name, type: "voice", position: nextChannelPosition(db), createdBy: null })`. `created_by` is nullable and the contract notes "null reserved for future system-seeded channels" — use `null` for the seeded channel. A restart finds the existing row and inserts nothing, satisfying "a restart does not create a second one."

## Data Flow

1. **Boot:** `buildApp(config)` → `openDatabase(config)` (applies schema) → `app.decorate("db", db)`. Insert `seedVoiceChannel(db)` here, before the gateway/routes are registered, so the voice row exists prior to any client connecting.
2. **Seed:** `seedVoiceChannel(db)` looks for an existing `type:"voice"` row; if absent, `createChannel(db, { name: <e.g. "Voice">, type: "voice", position: nextChannelPosition(db), createdBy: null })`.
3. **Expose (no code change):** a client completes `identify` on `/ws` → `buildReady(user)` → `listChannels(db).map(toPublicChannel)` includes the voice channel → sent as `ready.channels`. `GET /api/channels/:id/messages` and any `getChannelById` lookup see it too.
4. **Voice-type lookups (AC 4):** a new typed accessor (`getVoiceChannel(db)` returning the single `ChannelRow | undefined`, and/or callers using `getChannelById(...).type === "voice"`) lets story 003 validate that `voice.join` targets a voice channel and resolve the single room id.
5. **Invariant preserved (AC 3):** `POST /api/channels` keeps `type: { enum: ["text"] }`, so users still cannot create voice channels; duplicate-name rules unchanged.

## Decisions Made

1. **Add `seedVoiceChannel(db)` to `server/src/channels.ts` and call it from `buildApp` (not from `applySchema`/`openDatabase`).** Schema setup is pure DDL; seeding data rows belongs with the channel accessors and is invoked at app construction, matching the AC's "reachable from `buildApp`/startup, reusing `channels.ts` helpers." Keeping it out of `openDatabase` also avoids the CLI (`mint-token`, etc.) silently creating a voice channel every time it opens the db — seeding should be an app-boot concern, not a side effect of any db open.
2. **Idempotency by `WHERE type='voice'` lookup, not a fixed id or UNIQUE constraint.** The single-room v1 invariant is "exactly one voice channel," which a `type`-scoped existence check expresses directly and needs no schema migration. A `getVoiceChannel(db)` accessor doubles as the AC 4 typed lookup and the story-003 room resolver, so one helper covers both. (A partial unique index was considered but rejected: it requires a schema change and the in-app check is sufficient for ≤1 writer at boot.)
3. **Seeded channel name: a fixed literal (e.g. `"Voice"`), `created_by = null`, `position = nextChannelPosition(db)`.** `null` creator matches the contract's "null reserved for future system-seeded channels"; appending via `nextChannelPosition` keeps it ordered after the existing text channels and consistent with `listChannels`' `ORDER BY position, id`. The exact display string is cosmetic and not constrained by any contract; the implementer/plan picks it (default to `"Voice"` unless SPEC says otherwise).
4. **No gateway/types changes for exposure.** AC 2 explicitly says the channel flows through `listChannels → toPublicChannel` with "no gateway change," and the code confirms it — so `gateway.ts`, `types.ts`, and `routes/channels.ts` are read-only reference, not edits (the create-route enum stays as-is to satisfy AC 3).

## Open Questions

None — the data model, read path, and create-route guard already exist; this story is an additive seed helper, a typed voice lookup, a one-line `buildApp` call, and the contract doc. All choices follow established `channels.ts` conventions.
