#contract

# Contract: Data layer & crypto foundation (story 001)

Authoritative interface for the server persistence + crypto layer. Stories 002 (admin CLI),
003 (REST auth), and 004 (WS gateway) build on exactly what is documented here. Source of truth
for the data model is `SPEC.md §8`; for the crypto requirements, `SPEC.md §6` and `§12`.

All modules are ESM with `.js` import specifiers (e.g. `import { openDatabase } from "./db.js"`).
Files live under `server/src/`.

## Tables

Single SQLite file at `<config.dataDir>/app.db` (default `./data/app.db`). Created idempotently
on every `openDatabase`. Conventions: `id INTEGER PRIMARY KEY AUTOINCREMENT`; timestamps are
**unix epoch milliseconds** (`Date.now()`); booleans are `INTEGER` `0`/`1`. Foreign keys are
enforced (`PRAGMA foreign_keys = ON`).

`channels`, `messages`, `attachments` are NOT created in M1 (deferred to M2/M3).

### users

| column          | type    | constraints                  | notes                                              |
| --------------- | ------- | ---------------------------- | -------------------------------------------------- |
| `id`            | INTEGER | PRIMARY KEY AUTOINCREMENT     |                                                    |
| `username`      | TEXT    | NOT NULL UNIQUE              | uniqueness enforced by the column constraint       |
| `password_hash` | TEXT    | NOT NULL                     | Argon2id encoded string (`$argon2id$...`)          |
| `display_name`  | TEXT    | nullable                     |                                                    |
| `created_at`    | INTEGER | NOT NULL                     | epoch ms                                           |
| `disabled`      | INTEGER | NOT NULL DEFAULT 0           | 0 = active, 1 = disabled                           |

### invite_tokens

| column       | type    | constraints                          | notes                                          |
| ------------ | ------- | ------------------------------------ | ---------------------------------------------- |
| `id`         | INTEGER | PRIMARY KEY AUTOINCREMENT             |                                                |
| `token_hash` | TEXT    | NOT NULL                             | `hashToken(raw)` — SHA-256 hex of the raw token |
| `created_by` | INTEGER | nullable, FK → `users(id)`           | null when minted by admin/CLI with no user     |
| `created_at` | INTEGER | NOT NULL                             | epoch ms                                       |
| `used_by`    | INTEGER | nullable, FK → `users(id)`           | set when the token is consumed (registration)  |
| `used_at`    | INTEGER | nullable                             | epoch ms, set when consumed                    |
| `revoked`    | INTEGER | NOT NULL DEFAULT 0                    | 0/1                                            |

Index: `idx_invite_tokens_token_hash` on `(token_hash)` — used for the hash lookup on registration.

### sessions

| column       | type    | constraints                | notes                                                   |
| ------------ | ------- | -------------------------- | ------------------------------------------------------- |
| `id`         | INTEGER | PRIMARY KEY AUTOINCREMENT   |                                                         |
| `user_id`    | INTEGER | NOT NULL, FK → `users(id)` |                                                         |
| `token_hash` | TEXT    | NOT NULL                   | `hashToken(raw)` — SHA-256 hex of the raw session token |
| `created_at` | INTEGER | NOT NULL                   | epoch ms                                                |
| `expires_at` | INTEGER | NOT NULL                   | epoch ms; compute as `created_at + sessionTtlSeconds*1000` |
| `revoked`    | INTEGER | NOT NULL DEFAULT 0         | 0/1                                                     |

Index: `idx_sessions_token_hash` on `(token_hash)` — used for the hash lookup on the auth hot path.

## db module API (`server/src/db.ts`)

```ts
import type { Config } from "./config.js";

/** The opened SQLite handle (better-sqlite3 Database). */
export type Db = import("better-sqlite3").Database;

/**
 * mkdir -p <config.dataDir>, open <config.dataDir>/app.db,
 * PRAGMA journal_mode = WAL, PRAGMA foreign_keys = ON, applySchema(db), return handle.
 * No global singleton — call it once per process (server via buildApp, CLI directly).
 */
export function openDatabase(config: Config): Db;
```

- File location: `<config.dataDir>/app.db` (plus WAL sidecar files `app.db-wal` / `app.db-shm`).
- Pragmas set on open: `journal_mode = WAL`, `foreign_keys = ON`.
- Schema applied on open via `applySchema` (idempotent — safe on repeated/second-process opens).
- The server exposes the handle on the Fastify instance as **`app.db: Db`** (typed via a
  `declare module "fastify"` augmentation in `app.ts`). The handle is closed on Fastify `onClose`.
  Route plugins in stories 003/004 read `fastify.db`.
- The CLI (story 002) imports `openDatabase` and calls it directly against the same `DATA_DIR`.

## schema module API (`server/src/schema.ts`)

```ts
import type { Database } from "better-sqlite3";

/** Runs CREATE TABLE/INDEX IF NOT EXISTS for users/invite_tokens/sessions. Idempotent. */
export function applySchema(db: Database): void;
```

## Crypto helpers (`server/src/crypto.ts`)

```ts
/** Argon2id. Returns the encoded "$argon2id$..." string (embeds salt + params). Store in users.password_hash. */
export function hashPassword(password: string): Promise<string>;

/** Verifies a password against an Argon2id hash. Returns false (never throws) on mismatch OR malformed hash. */
export function verifyPassword(hash: string, password: string): Promise<boolean>;

/** URL-safe opaque token: randomBytes(32).toString("base64url") (43 chars). Used for invite AND session tokens. */
export function generateToken(): string;

/** SHA-256 hex of a raw token. Store this in *.token_hash; never store the raw token. */
export function hashToken(raw: string): string;
```

### Hashing scheme

- **Passwords**: Argon2id (library defaults), stored as the encoded string in `users.password_hash`.
  Login compares with `verifyPassword(stored, submitted)`; a `false` result (mismatch or malformed)
  lets the caller return a single uniform 401 (no user enumeration).
- **Tokens** (invite + session): generated with `generateToken()` (high-entropy random, URL-safe).
  The **raw** value is shown to the user exactly once (printed by the CLI / returned by login);
  only `hashToken(raw)` (SHA-256 hex) is ever persisted, in the respective `token_hash` column.
  Lookups hash the submitted token and `SELECT ... WHERE token_hash = ?`.

## Usage notes for 002–004

- **Invite mint (002):** `raw = generateToken()`; print `raw` once; insert
  `invite_tokens(token_hash = hashToken(raw), created_by, created_at = Date.now(), revoked = 0)`.
- **Register (003):** `hashToken(submitted)` → look up by index → reject if missing/`revoked`/`used_by` set →
  insert user with `password_hash = await hashPassword(pw)`, `created_at = Date.now()`, `disabled = 0` →
  mark token `used_by`/`used_at = Date.now()`.
- **Login (003):** look up user by `username`; `await verifyPassword(user.password_hash, pw)`; on success
  `raw = generateToken()`, insert `sessions(user_id, token_hash = hashToken(raw), created_at = Date.now(),
  expires_at = Date.now() + config.sessionTtlSeconds*1000, revoked = 0)`; return `raw` to the client.
- **Authenticate (003/004):** `hashToken(bearer)` → look up session by index → reject if `revoked`,
  `expires_at <= Date.now()`, or the owning user is `disabled`.
- Reach the db via `fastify.db` inside route plugins; do not open a second connection in the server process.
