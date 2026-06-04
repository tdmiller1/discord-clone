#research

# Research: Server data layer & crypto foundation

## Files to Touch

### Likely Modified
- `server/package.json` — add runtime deps `better-sqlite3` and an Argon2 lib, plus the matching `@types/better-sqlite3` devDep. (`@node-rs/argon2` ships its own types; the classic `argon2` package does too.)
- `server/src/app.ts` — `buildApp(config)` currently takes only `Config`. The story requires the `db` handle to be "constructed from `Config` and passed into `buildApp`". Decide between (a) widening the `buildApp` signature to accept the db, or (b) constructing the db *inside* `buildApp` from `config.dataDir`. See Decisions — recommended approach is (b) construct inside `buildApp`, with the db creation factored into its own module so the CLI can call the same factory. `app.ts` will import and call `openDatabase(config)` and (optionally) decorate the Fastify instance with it for downstream stories. No routes are added in this story.
- `server/src/index.ts` — only if `buildApp` needs the db passed in (option (a)). With the recommended option (b) `index.ts` needs **no change** (it already does `buildApp(loadConfig())`), which preserves the "index.ts stays listen + signal-handling only" rule. Note this in the plan.

### Likely Created
- `server/src/db.ts` — the db accessor module. Exports a factory like `openDatabase(config: Config): Database.Database` (or a small wrapper type) that: resolves `<config.dataDir>/app.db`, `mkdir -p`s the data dir if missing, opens the better-sqlite3 connection, sets pragmatic pragmas (`journal_mode = WAL`, `foreign_keys = ON`), and runs the idempotent schema migration. This is the single source of truth consumed by stories 002 (CLI), 003 (REST), 004 (gateway).
- `server/src/schema.ts` (or inline in `db.ts`) — the `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` DDL for `users`, `invite_tokens`, `sessions` per `SPEC.md §8`, plus an `applySchema(db)` function. Keeping it in its own module keeps `db.ts` focused on connection lifecycle; acceptable to inline given small size — see Decisions.
- `server/src/crypto.ts` — the shared crypto helpers: `hashPassword`, `verifyPassword` (Argon2id), `generateToken` (random URL-safe string), `hashToken` (SHA-256 hex of the raw token). Used by both invite-token (story 002) and session (story 003) paths.
- `context/features/m1-auth-ws-presence/contracts/data-and-crypto.md` — the contract file named in the story frontmatter (`provides_contract: contracts/data-and-crypto.md`). The `contracts/` dir does **not exist yet** and must be created. Document: table column shapes + types + constraints, the `db.ts` module API (factory signature, what it returns, pragmas, where the file lives), and the crypto helper signatures + hashing scheme so stories 002–004 can rely on them.

### Read-Only Reference (patterns to follow)
- `server/src/config.ts` — the `Config` interface and `loadConfig()`. `config.dataDir` is the directory to put `app.db` in. Crypto/db code reads everything from `Config`, never `process.env`. Note `num()` helper + env-driven pattern if any new config knob is added (none strictly required this story; Argon2 params can be hardcoded constants).
- `server/src/app.ts` — the `buildApp(config)` shape and the JSDoc style. Mirror the comment style and the ESM `.js` import specifiers (`import { ... } from "./config.js"`).
- `server/src/index.ts` — confirms the entry stays minimal; the CLI (story 002) will be a *separate* entry that also calls `openDatabase(config)`.
- `server/Dockerfile` — `node:24-bookworm-slim`, two-stage, `npm ci` in both stages. Relevant because `better-sqlite3` is a native addon (see Open Questions / Decisions about build deps).
- `server/tsconfig.json` — `module`/`moduleResolution: NodeNext`, `strict: true`. New modules must satisfy strict mode and use `.js` import specifiers.
- `SPEC.md §8` (data model), `§6` (auth flows: hashed single-use invite tokens, Argon2id passwords, server-side sessions), `§12` (Argon2id + hashed tokens requirement). These are the authoritative column lists and crypto requirements.

## Existing Patterns

The server is small and consistent. Patterns to copy:

- **Config flows through `Config`.** `server/src/config.ts` defines `interface Config { ... dataDir: string; sessionTtlSeconds: number; ... }` and `loadConfig()` builds it from env with a `num()` helper. Everything downstream takes `config: Config` as a parameter — no module reads `process.env` directly. `db.ts` and `crypto.ts` follow this: `openDatabase(config: Config)`.
- **`buildApp(config)` testability split** (`server/src/app.ts`): the app is built in a pure function so tests can construct it without `listen()`. `index.ts` only does `loadConfig()` → `buildApp(config)` → `app.listen(...)` + signal handlers. The db must be reachable by `buildApp` *and* by the standalone CLI (story 002) — so the db construction belongs in a shared factory (`openDatabase`) that both entry points call, not buried inside `buildApp` only. Fastify decoration (`app.decorate("db", db)`) is the idiomatic way to make the handle available to later route plugins; downstream stories 003/004 can read `app.db`.
- **ESM `.js` specifiers**: every relative import carries `.js` (e.g. `import type { Config } from "./config.js"`). New files must do the same.
- **JSDoc block comments** referencing `SPEC.md §N` on exported functions/modules (see `app.ts`, `config.ts`). Match this.
- **No test runner**: the only gate is `npm run typecheck` (`tsc --noEmit`). Verification of the db/tables is manual (`sqlite3 <dataDir>/app.db ".schema"`) or by starting the server and inspecting. The plan's acceptance check is "typecheck passes + starting the server creates the file and tables".

There is **no existing db, migration, or crypto code** anywhere in the repo — this story creates the first persistence + crypto layer from scratch. So there is no closer analogue than the config/app module shapes above.

## Data Flow

This story builds the foundation; the consuming flows belong to later stories, but the intended path is:

1. **Startup (server):** `index.ts` → `loadConfig()` → `buildApp(config)`. Inside `buildApp` (recommended), `openDatabase(config)` is called: it computes `path.join(config.dataDir, "app.db")`, `fs.mkdirSync(config.dataDir, { recursive: true })`, opens `new Database(dbPath)`, sets pragmas, and runs `applySchema(db)` (idempotent `CREATE TABLE/INDEX IF NOT EXISTS`). The handle is decorated onto the Fastify instance for later route plugins.
2. **Startup (CLI, story 002):** `cli.ts` → `loadConfig()` → `openDatabase(config)` against the **same** `DATA_DIR`/`app.db`, so a token minted via `docker exec` is immediately visible to the running server (single SQLite file, WAL is fine for one writer process at a time; CLI and server are separate processes but the file is shared — note WAL allows concurrent readers and the brief CLI write is safe).
3. **Crypto usage (later):**
   - Invite token (story 002 mint): `generateToken()` → print raw to stdout once; store `hashToken(raw)` in `invite_tokens.token_hash`. Register (story 003): `hashToken(submitted)` → `SELECT ... WHERE token_hash = ?` → check unused & not revoked → set `used_by`/`used_at`.
   - Password (story 003): register stores `hashPassword(password)` in `users.password_hash`; login does `verifyPassword(hash, password)`.
   - Session (story 003): `generateToken()` → return raw to client; store `hashToken(raw)` in `sessions.token_hash` with `expires_at = now + config.sessionTtlSeconds`. Auth (story 003/004): `hashToken(bearer)` → lookup by hash → check not expired/revoked + user not disabled.
4. **Data store:** single SQLite file at `<dataDir>/app.db`. Tables this story creates (per `SPEC.md §8`):
   - `users`: `id, username UNIQUE, password_hash, display_name, created_at, disabled`
   - `invite_tokens`: `id, token_hash, created_by, created_at, used_by NULL, used_at NULL, revoked`
   - `sessions`: `id, user_id, token_hash, created_at, expires_at, revoked`
   - Indexes: `invite_tokens.token_hash`, `sessions.token_hash` (both used for hash lookups on the hot auth path). `users.username` gets uniqueness via the `UNIQUE` column constraint.
   - `channels`/`messages`/`attachments` are **explicitly out of scope** (M2/M3) per the story.

## Decisions Made

1. **Argon2 library: use `argon2` (the node-gyp/prebuild package) — but flag `@node-rs/argon2` as the lower-friction alternative in the plan.** Both implement Argon2id. `@node-rs/argon2` is a prebuilt Rust napi binary (no compiler needed in the Docker build, ships its own TS types, simplest `bookworm-slim` story), whereas the classic `argon2` package may need build tools if no prebuilt matches Node 24. Given the Dockerfile is `node:24-bookworm-slim` with no build toolchain installed, **`@node-rs/argon2` is the recommended choice** to avoid Docker build failures — the planner should pick it unless there's a reason not to. Its API is `hash(password)` / `verify(hash, password)` with an `argon2id` variant default, which maps cleanly onto `hashPassword`/`verifyPassword`. (Rationale: matches the "low-effort deploy" constraint and the existing slim image; avoids adding python3/make/g++ to the image just for password hashing.)

2. **`hashToken` = SHA-256 hex via Node's built-in `crypto`.** The story says "e.g. SHA-256 of the raw token". Tokens are high-entropy random values (not low-entropy passwords), so a fast cryptographic hash is the standard, correct choice — no salt/Argon2 needed for token-at-rest. Use `crypto.createHash("sha256").update(raw).digest("hex")` from the Node stdlib (zero new deps). `generateToken` uses `crypto.randomBytes(32).toString("base64url")` for a URL-safe opaque token (base64url avoids `+/=` issues in headers/JSON).

3. **Construct the db inside `buildApp(config)` (and in a shared `openDatabase` factory), not by widening the `buildApp` signature.** This keeps `index.ts` untouched (preserving the "listen + signals only" rule) and keeps the single-arg `buildApp(config)` testability shape the story explicitly says to preserve. The shared factory `openDatabase(config)` is what makes the handle "reachable by the CLI" without a global singleton — both entry points call it independently. Expose on Fastify via `app.decorate("db", db)` for downstream route stories. (Tests can still call `openDatabase(config)` with an in-memory or temp-dir config.)

4. **Schema applied at open time, idempotently, in TS DDL (no migration framework).** With `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` run on every `openDatabase`, no migration tooling is warranted for a ≤10-user single-file app. Keep DDL as a multi-statement string executed with `db.exec(...)`. Split into `schema.ts` (or inline in `db.ts`) — either is fine; recommend a small `schema.ts` exporting `applySchema(db)` for readability and so the CLI/tests can reuse it.

5. **Pragmas: `journal_mode = WAL` and `foreign_keys = ON`.** WAL improves concurrency between the server process and the occasional CLI write against the shared file; `foreign_keys = ON` enforces the `sessions.user_id`/token relationships better-sqlite3 leaves off by default. Set these in `openDatabase` right after opening.

6. **Column types/defaults inferred from `SPEC.md §8` conventions** (the spec lists names + nullability but not SQLite types). Recommended concrete shapes for the contract: `id INTEGER PRIMARY KEY AUTOINCREMENT` (or `TEXT` if the team prefers opaque ids — recommend INTEGER for the keyset pagination mentioned in §9 for later milestones), timestamps as `created_at INTEGER NOT NULL` (unix epoch ms/seconds — recommend ms via `Date.now()` for consistency, document the unit in the contract), booleans as `disabled INTEGER NOT NULL DEFAULT 0` / `revoked INTEGER NOT NULL DEFAULT 0`, nullable columns (`used_by`, `used_at`, `display_name`) without `NOT NULL`. The planner should lock these exact types in the contract so 002–004 agree on them.

7. **Create the `contracts/` directory** under `context/features/m1-auth-ws-presence/` — it does not exist yet and three stories reference contract files inside it. This story creates the dir with `data-and-crypto.md`.

## Open Questions

None that block implementation. The one item worth the planner's explicit attention (not a blocker, just a decision to lock) is the **Argon2 library choice** and its Docker build implication: the current `node:24-bookworm-slim` image has no C build toolchain, so a native-compiled `argon2` could fail `npm ci` in the runtime stage. Decision #1 resolves this by recommending the prebuilt `@node-rs/argon2`; if the team insists on the classic `argon2`, the plan must add `python3 make g++` (or `build-essential`) to the build stage and ensure a prebuilt binary is copied/available to the runtime stage. `better-sqlite3` ships prebuilt binaries for current Node versions, so it is the lower risk of the two, but the plan should still verify the prebuild covers Node 24 / bookworm during implementation.
