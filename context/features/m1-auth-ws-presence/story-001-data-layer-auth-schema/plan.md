#plan

# Plan: Server data layer & crypto foundation

## Summary
Add the first persistence + crypto layer to the ESM server: a `better-sqlite3`-backed `db` module that opens/creates `<dataDir>/app.db` (with WAL + foreign-key pragmas) and idempotently applies the `users`/`invite_tokens`/`sessions` schema per `SPEC.md §8`, plus a `crypto` module exposing Argon2id password helpers and SHA-256 token hashing/generation. The shared `openDatabase(config)` factory is called by `buildApp` (which decorates the handle onto Fastify) and will be reused by the CLI in story 002; the new `contracts/data-and-crypto.md` documents the table shapes, the db module API, and the hashing scheme for stories 002–004.

Decisions locked while planning (all derived from `research.md` "Decisions Made"; none were genuine blockers):
- **Argon2 library: `@node-rs/argon2`** (prebuilt napi binary, ships its own types, no C toolchain needed in `node:24-bookworm-slim`). Avoids adding build deps to the Dockerfile. `better-sqlite3` ships prebuilt binaries for current Node, so it carries `@types/better-sqlite3` as the only added devDep.
- **`hashToken` = SHA-256 hex** via Node stdlib `node:crypto` (tokens are high-entropy, so a fast cryptographic hash is correct — no Argon2/salt). **`generateToken` = `randomBytes(32).toString("base64url")`** (URL-safe opaque token).
- **db constructed inside `buildApp` via shared `openDatabase(config)` factory**, decorated as `app.db` — `index.ts` is left unchanged (preserves the "listen + signals only" and single-arg `buildApp(config)` rules); the CLI calls the same factory independently (no global singleton).
- **Schema is `CREATE TABLE/INDEX IF NOT EXISTS` run on every open** (no migration framework) via `applySchema(db)` in its own `schema.ts` for reuse/readability.
- **Concrete column types (locked for the contract):** `id INTEGER PRIMARY KEY AUTOINCREMENT`; timestamps `INTEGER NOT NULL` storing **unix epoch milliseconds** (`Date.now()`); booleans `INTEGER NOT NULL DEFAULT 0`; nullable columns (`display_name`, `used_by`, `used_at`) declared without `NOT NULL`.

## Implementation Steps

### Step 1: Add runtime + dev dependencies
**File(s):** `server/package.json`
**Action:** modify
**Description:** Add the persistence and crypto runtime deps and the SQLite types so the new modules typecheck and run. `@node-rs/argon2` ships its own types; `better-sqlite3` needs the separate `@types/better-sqlite3` devDep.
**Diff shape:**
- Add (dependencies): `"better-sqlite3": "^11.8.1"`, `"@node-rs/argon2": "^2.0.2"` (use the latest stable matching Node 24 at install time).
- Add (devDependencies): `"@types/better-sqlite3": "^7.6.12"`.
- Change: run `npm install` in `server/` after editing so `package-lock.json` is updated (the Dockerfile relies on `npm ci`, which requires the lockfile to be in sync).
- Remove: nothing.

### Step 2: Create the crypto helpers module
**File(s):** `server/src/crypto.ts`
**Action:** create
**Description:** Centralize all hashing/token logic so the REST API (003), CLI (002), and gateway (004) share one implementation. Export the four helpers required by the acceptance criteria. Use `@node-rs/argon2` for password hashing/verification (Argon2id is its default variant) and Node's built-in `node:crypto` for token generation + hashing. Include JSDoc referencing `SPEC.md §6`/`§12`. Use `.js` import specifiers per ESM convention (note: `node:crypto` is a bare specifier and needs no extension).
**Diff shape:**
- Add: `import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";`
- Add: `import { randomBytes, createHash } from "node:crypto";`
- Add: `export async function hashPassword(password: string): Promise<string>` → `return argon2Hash(password);` (Argon2id with library defaults; returns the encoded `$argon2id$...` string that embeds salt+params).
- Add: `export async function verifyPassword(hash: string, password: string): Promise<boolean>` → `return argon2Verify(hash, password);` (returns `false` rather than throwing on a malformed/non-matching hash where the library allows; if the library throws on malformed input, wrap in try/catch returning `false` to keep login a uniform 401 in 003).
- Add: `export function generateToken(): string` → `return randomBytes(32).toString("base64url");`
- Add: `export function hashToken(raw: string): string` → `return createHash("sha256").update(raw).digest("hex");`

### Step 3: Create the schema (DDL) module
**File(s):** `server/src/schema.ts`
**Action:** create
**Description:** Hold the idempotent DDL for the three M1 tables and their indexes exactly per `SPEC.md §8`, plus an `applySchema(db)` function so `openDatabase` (and tests/CLI) can run it. Use a single multi-statement string executed with `db.exec(...)`. Channels/messages/attachments are explicitly out of scope. JSDoc references `SPEC.md §8`.
**Diff shape:**
- Add: `import type { Database } from "better-sqlite3";` (type-only import of the default export's namespace; the value import lives in `db.ts`).
- Add: a `const SCHEMA_SQL = \`...\`` string containing:
  - `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name TEXT, created_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);`
  - `CREATE TABLE IF NOT EXISTS invite_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL, created_by INTEGER, created_at INTEGER NOT NULL, used_by INTEGER, used_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0, FOREIGN KEY (created_by) REFERENCES users(id), FOREIGN KEY (used_by) REFERENCES users(id));`
  - `CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, FOREIGN KEY (user_id) REFERENCES users(id));`
  - `CREATE INDEX IF NOT EXISTS idx_invite_tokens_token_hash ON invite_tokens(token_hash);`
  - `CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);`
- Add: `export function applySchema(db: Database): void { db.exec(SCHEMA_SQL); }`

### Step 4: Create the db accessor/factory module
**File(s):** `server/src/db.ts`
**Action:** create
**Description:** The single source of truth for opening the SQLite connection. `openDatabase(config)` resolves `<config.dataDir>/app.db`, creates the data dir if missing, opens the connection, sets pragmas (`journal_mode = WAL`, `foreign_keys = ON`), runs `applySchema`, and returns the handle. Config flows in via `Config` (never `process.env`). JSDoc references `SPEC.md §8`. Also export a `Db` type alias so downstream modules and the Fastify decoration declaration can reference the handle type without importing `better-sqlite3` directly.
**Diff shape:**
- Add: `import Database from "better-sqlite3";` (default value import — works under `esModuleInterop: true`).
- Add: `import { mkdirSync } from "node:fs";`
- Add: `import { join } from "node:path";`
- Add: `import type { Config } from "./config.js";`
- Add: `import { applySchema } from "./schema.js";`
- Add: `export type Db = Database.Database;`
- Add: `export function openDatabase(config: Config): Db {`
  - `mkdirSync(config.dataDir, { recursive: true });`
  - `const db = new Database(join(config.dataDir, "app.db"));`
  - `db.pragma("journal_mode = WAL");`
  - `db.pragma("foreign_keys = ON");`
  - `applySchema(db);`
  - `return db;`
  - `}`

### Step 5: Wire the db into buildApp via Fastify decoration
**File(s):** `server/src/app.ts`
**Action:** modify
**Description:** Construct the db inside `buildApp` (preserving the single-arg signature) and decorate it onto the Fastify instance as `app.db` so route plugins in stories 003/004 can read it. Add a TypeScript module augmentation so `app.db` is strongly typed on `FastifyInstance`. Register an `onClose` hook to close the db cleanly on shutdown. No routes added.
**Diff shape:**
- Add imports: `import { openDatabase, type Db } from "./db.js";`
- Add (module augmentation, top of file after imports): `declare module "fastify" { interface FastifyInstance { db: Db; } }`
- Change `buildApp`: after `const app = Fastify({...})` (and after CORS register is fine), add:
  - `const db = openDatabase(config);`
  - `app.decorate("db", db);`
  - `app.addHook("onClose", async () => { db.close(); });`
- Remove: nothing (existing `/health` and `/` routes stay).

### Step 6: Confirm index.ts and config require no changes
**File(s):** `server/src/index.ts`, `server/src/config.ts`
**Action:** (verify — no edit)
**Description:** `index.ts` already does `loadConfig()` → `buildApp(config)` → `listen`, and `buildApp` now opens the db internally, so the entry point needs no change (preserves the "listen + signals only" rule). `config.ts` already exposes `dataDir` and `sessionTtlSeconds`; this story introduces no new env var (Argon2 params are library defaults / hardcoded). Note in the plan that no `.env.example` or `config.ts` change is needed.
**Diff shape:**
- Add: nothing.
- Remove: nothing.
- Change: nothing — documented here only to make the no-op explicit.

### Step 7: Verify build/typecheck and runtime schema creation
**File(s):** none (verification step)
**Action:** (verify)
**Description:** Run the only static gate and a manual runtime check. `npm run typecheck` (from repo root) must pass. Then start the server (`npm run dev:server`) and confirm `<dataDir>/app.db` is created and contains the three tables + two indexes, e.g. `sqlite3 ./data/app.db ".schema"` (or `.tables`). Also confirm a clean second startup does not error (idempotent DDL). If `better-sqlite3`'s prebuilt binary does not cover Node 24/bookworm at install time, fall back to adding `python3 make g++` to the Docker build stage (note as a contingency, not expected).
**Diff shape:**
- Add: nothing.
- Remove: nothing.

### Step 8: Create the contracts directory and contract doc
**File(s):** `context/features/m1-auth-ws-presence/contracts/data-and-crypto.md`
**Action:** create
**Description:** Create the `contracts/` directory (does not exist yet — three stories reference files inside it) and the contract doc this story's frontmatter promises. Document, authoritatively for stories 002–004: (1) exact table column names/types/constraints/defaults and the timestamp unit (epoch ms); (2) the `db` module API — `openDatabase(config): Db`, `Db` type, file location `<dataDir>/app.db`, pragmas set, idempotent schema, and that the handle is exposed as Fastify `app.db`; (3) the crypto helper signatures and hashing scheme (Argon2id encoded-string passwords, SHA-256 hex token hashes, base64url token generation), including which fields store hashes vs raw (raw token is shown to the user once; only `token_hash` is persisted).
**Diff shape:**
- Add: new markdown file with `#contract` tag, sections "Tables", "db module API", "Crypto helpers", and a short "Usage notes for 002–004".

## New Types / Schemas / Contracts

Persisted SQLite schema (authoritative for 002–004):

```sql
-- users
id            INTEGER PRIMARY KEY AUTOINCREMENT
username      TEXT    NOT NULL UNIQUE
password_hash TEXT    NOT NULL              -- Argon2id encoded string ($argon2id$...)
display_name  TEXT                          -- nullable
created_at    INTEGER NOT NULL              -- unix epoch ms (Date.now())
disabled      INTEGER NOT NULL DEFAULT 0    -- 0/1 boolean

-- invite_tokens
id          INTEGER PRIMARY KEY AUTOINCREMENT
token_hash  TEXT    NOT NULL               -- sha256 hex of the raw invite token
created_by  INTEGER                        -- users(id), nullable (CLI/admin may be null)
created_at  INTEGER NOT NULL               -- epoch ms
used_by     INTEGER                        -- users(id), nullable until consumed
used_at     INTEGER                        -- epoch ms, nullable until consumed
revoked     INTEGER NOT NULL DEFAULT 0     -- 0/1 boolean
-- indexed: idx_invite_tokens_token_hash (token_hash)

-- sessions
id          INTEGER PRIMARY KEY AUTOINCREMENT
user_id     INTEGER NOT NULL               -- users(id)
token_hash  TEXT    NOT NULL               -- sha256 hex of the raw session token
created_at  INTEGER NOT NULL               -- epoch ms
expires_at  INTEGER NOT NULL               -- epoch ms (created_at + sessionTtlSeconds*1000)
revoked     INTEGER NOT NULL DEFAULT 0     -- 0/1 boolean
-- indexed: idx_sessions_token_hash (token_hash)
```

db module API (`server/src/db.ts`):

```ts
type Db = import("better-sqlite3").Database; // re-exported as `Db`
function openDatabase(config: Config): Db;   // mkdir dataDir, open <dataDir>/app.db,
                                             // pragma WAL + foreign_keys=ON, applySchema, return handle
// Fastify: app.db is decorated and typed via module augmentation (FastifyInstance.db: Db)
```

schema module API (`server/src/schema.ts`):

```ts
function applySchema(db: Db): void; // runs CREATE TABLE/INDEX IF NOT EXISTS (idempotent)
```

crypto module API (`server/src/crypto.ts`):

```ts
function hashPassword(password: string): Promise<string>;          // Argon2id encoded string
function verifyPassword(hash: string, password: string): Promise<boolean>;
function generateToken(): string;                                  // randomBytes(32).base64url
function hashToken(raw: string): string;                           // sha256 hex
```

## Configuration / Environment Changes

- **No new environment variables.** The story reuses existing `config.dataDir` (the SQLite file lives at `<dataDir>/app.db`) and `config.sessionTtlSeconds` (consumed later by 003 for `expires_at`). Argon2 parameters use library defaults (no env knob).
- **No `server/.env.example` change** required.
- **New persisted schema:** the three tables + two indexes listed above (created at runtime by `applySchema`, registered in `server/src/schema.ts`).
- **New dependencies registered in `server/package.json`:** `better-sqlite3`, `@node-rs/argon2` (deps); `@types/better-sqlite3` (devDep). `package-lock.json` must be regenerated.

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| public function | `openDatabase` (`server/src/db.ts`) | `config: Config` | `Db` (better-sqlite3 `Database`) | Side effects: mkdir `dataDir`, open `<dataDir>/app.db`, set WAL + FK pragmas, apply schema. Shared by `buildApp` and the story-002 CLI. |
| type export | `Db` (`server/src/db.ts`) | — | `better-sqlite3.Database` | Stable type name for downstream imports + Fastify decoration. |
| public function | `applySchema` (`server/src/schema.ts`) | `db: Db` | `void` | Idempotent DDL; safe to call repeatedly. |
| Fastify decoration | `app.db` (`server/src/app.ts`) | — | `Db` | Typed via `declare module "fastify"`. Closed on `onClose`. Read by routes in 003/004. |
| public function | `hashPassword` (`server/src/crypto.ts`) | `password: string` | `Promise<string>` | Argon2id encoded string (embeds salt+params). |
| public function | `verifyPassword` (`server/src/crypto.ts`) | `hash, password: string` | `Promise<boolean>` | Returns `false` on mismatch/malformed (no throw) for uniform 401 in 003. |
| public function | `generateToken` (`server/src/crypto.ts`) | — | `string` | 32 random bytes, base64url. Used for invite + session tokens. |
| public function | `hashToken` (`server/src/crypto.ts`) | `raw: string` | `string` | SHA-256 hex. Stored in `*.token_hash`. |
| persisted schema | `users` / `invite_tokens` / `sessions` | — | — | Exact columns/types/constraints above per `SPEC.md §8`. |

No HTTP routes, WS ops, or CLI commands are added in this story.

## Edge Cases & Gotchas

- **Missing data directory on first boot** — `openDatabase` `mkdirSync(dataDir, { recursive: true })` before opening, so a fresh deploy with an empty `/data` volume works. Handled in Step 4.
- **Repeated startups / second process** — DDL is `CREATE ... IF NOT EXISTS`, so re-running `applySchema` on an existing db is a no-op and never errors. Handled in Step 3/Step 7 (verified).
- **Concurrent server + CLI access to one file** — WAL mode (Step 4) allows concurrent readers with one writer; the CLI's brief writes against the same `app.db` are safe. The CLI calls the same `openDatabase` factory (story 002) rather than a separate handle, avoiding divergent pragmas.
- **Foreign-key enforcement off by default** — better-sqlite3 does not enable FKs unless told; `pragma("foreign_keys = ON")` (Step 4) enforces `sessions.user_id` / `invite_tokens.*_by` so later inserts referencing a missing user fail loudly. Note WAL is set before FK; ordering is fine.
- **Uniform login failure (no user enumeration)** — `verifyPassword` returns `false` (not throw) on a malformed/non-matching hash so 003 can return a single 401 for both "no such user" and "wrong password". Handled in Step 2.
- **Raw vs hashed token confusion** — contract (Step 8) explicitly states only `token_hash` is persisted and the raw token is shown once; `generateToken` produces the raw value, `hashToken` produces the stored value. Prevents 002/003 from accidentally storing raw tokens.
- **Timestamp unit ambiguity** — `SPEC.md §8` lists `created_at`/`expires_at` without a unit; this plan locks **epoch milliseconds (`Date.now()`)** and documents it in the contract so 002–004 compute `expires_at` consistently. Handled in Step 3/Step 8.
- **Native-addon build in slim Docker image** — `@node-rs/argon2` (prebuilt napi) and `better-sqlite3` (prebuilt) avoid needing a C toolchain in `node:24-bookworm-slim`. Contingency if a prebuild is missing for Node 24: add `python3 make g++` to the Docker build stage. Noted in Step 1/Step 7.
- **Lockfile drift breaks Docker `npm ci`** — the Dockerfile uses `npm ci`, which fails if `package-lock.json` is out of sync; Step 1 requires regenerating the lockfile after adding deps.
- **db not closed on shutdown** — `onClose` hook in `buildApp` (Step 5) closes the handle so SIGINT/SIGTERM via `app.close()` flushes WAL cleanly; tests that build and close the app also release the file.

## Acceptance Criteria Checklist

- [ ] `better-sqlite3` added to `server/` deps; a `db` module opens/creates `<dataDir>/app.db`, creating the dir if missing → Step 1, Step 4
- [ ] Schema created idempotently on startup (`CREATE TABLE IF NOT EXISTS`) for `users`, `invite_tokens`, `sessions` exactly per `SPEC.md §8` → Step 3, Step 5 (applied via `buildApp`→`openDatabase`)
- [ ] `users.username` is `UNIQUE`; indexes exist on `invite_tokens.token_hash` and `sessions.token_hash` → Step 3
- [ ] Crypto helpers exported: `hashPassword`/`verifyPassword` (Argon2id), `generateToken` (URL-safe), `hashToken` (SHA-256), used for both invite + session tokens → Step 2 (documented for reuse in Step 8)
- [ ] `db` handle constructed from `Config` and reachable by `buildApp` and the CLI, no global singletons / scattered `process.env`; `buildApp(config)` testability split preserved → Step 4 (shared `openDatabase` factory), Step 5 (decorate, single-arg signature), Step 6 (index.ts unchanged)
- [ ] `npm run typecheck` passes; starting the server creates the db file + tables → Step 7
- [ ] `contracts/data-and-crypto.md` documents table shapes, db module API, hashing scheme → Step 8
