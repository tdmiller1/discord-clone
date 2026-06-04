#research

# Research: Auth REST API (register, login, session)

## Files to Touch

### Likely Modified
- `server/src/app.ts` — register the auth routes + the rate-limit plugin + the auth decorator/`preHandler` inside `buildApp(config)`. Add a `declare module "fastify"` augmentation for the `requireAuth` decorator and the `request.user` property (alongside the existing `db` augmentation). `buildApp` must become `async`/return a `Promise<FastifyInstance>` if it `await app.register(...)`s the new plugins (see Decisions) — or register them with `void` like the existing CORS line and rely on Fastify's ready ordering. `index.ts` already `await`s nothing that would break if `buildApp` stays sync, but `index.ts` calls `buildApp(config)` synchronously, so prefer keeping it sync (Decision 5).
- `server/package.json` — add `@fastify/rate-limit` (`^10.x`, matches Fastify v5) to `dependencies`. No other deps needed (`@node-rs/argon2`, `better-sqlite3`, `fastify`, `@fastify/cors` already present).
- `server/.env.example` — optionally document new rate-limit env vars (`AUTH_RATE_MAX`, `AUTH_RATE_WINDOW`) if Decision 4 chooses to make limits configurable. SPEC.md §12 lists the canonical env vars; rate-limit knobs are not in it, so keeping them as hardcoded sane defaults is also acceptable.

### Likely Created
- `server/src/routes/auth.ts` — a Fastify plugin (`export default async function authRoutes(app, opts)` or a named `registerAuthRoutes(app)`) holding `POST /api/register`, `/api/login`, `/api/logout`, and optional `/api/refresh`. This is where the register/login/session DB logic lives.
- `server/src/auth.ts` — the **reusable session validator** + the `requireAuth` Fastify `preHandler` decorator. Must export a framework-agnostic `authenticateSession(db, rawToken): { user, session } | null` so story 004's WS gateway can call it without a Fastify request. This is the key cross-story contract surface (AC #4). The `requireAuth` preHandler wraps it, parses the `Authorization: Bearer` header, sets `request.user`, and sends a uniform 401 on failure.
- `server/src/types.ts` (optional) — shared TS types for the row shapes (`UserRow`, `SessionRow`) and the public `PublicUser` response shape, if not co-located in `auth.ts`. better-sqlite3 returns `unknown`/`any` from `.get()`, so a small typed cast helper is useful.
- `context/features/m1-auth-ws-presence/story-003-auth-rest-api/contracts/auth-api.md` — the output contract (AC #8): request/response JSON shapes, error codes, the Bearer scheme. Consumed by story 004 (WS) and 006 (client). Mirror the structure of story 001's `contracts/data-and-crypto.md`.

### Read-Only Reference (patterns to follow)
- `server/src/app.ts` — current `buildApp(config)` shape, the `declare module "fastify"` augmentation pattern, `app.decorate("db", db)`, `app.register(cors, {...})` with `void`, `onClose` hook. Copy these idioms exactly.
- `server/src/db.ts` / `server/src/schema.ts` — the table/column names and that the handle is `better-sqlite3` (synchronous prepared statements: `db.prepare(sql).get(...)` / `.run(...)`).
- `server/src/crypto.ts` — the exact helper signatures the routes must call: `hashPassword`, `verifyPassword`, `generateToken`, `hashToken` (all already implemented; `hashPassword`/`verifyPassword` are async).
- `server/src/config.ts` — `loadConfig()` + the `num()` helper pattern for adding env-driven settings; `config.sessionTtlSeconds` is the session TTL source.
- `context/features/m1-auth-ws-presence/story-001-data-layer-auth-schema/contracts/data-and-crypto.md` — authoritative DB/crypto interface; the "Usage notes for 002–004" section literally spells out the register/login/authenticate SQL flow. Follow it verbatim.

## Existing Patterns

- **App construction:** `buildApp(config: Config): FastifyInstance` in `server/src/app.ts`. It creates `Fastify({ logger: { level: ... } })`, registers CORS via `void app.register(cors, { origin: true })`, opens the DB with `openDatabase(config)`, exposes it via `app.decorate("db", db)`, adds an `onClose` hook to close the DB, then declares routes with `app.get(...)`. New auth plugins/routes go here, before `return app`.
- **Fastify type augmentation:** the existing block
  ```ts
  declare module "fastify" {
    interface FastifyInstance { db: Db; }
  }
  ```
  is the pattern for adding `requireAuth` to `FastifyInstance` and `user` to `FastifyRequest`.
- **ESM `.js` specifiers:** every relative import uses `.js` (`./config.js`, `./db.js`, `./schema.js`). New modules must too (`./routes/auth.js`, `./auth.js`, `./crypto.js`).
- **DB access is synchronous** (`better-sqlite3`): `db.prepare("SELECT ... WHERE token_hash = ?").get(hash)` returns a row or `undefined`; `.run(...)` returns `{ changes, lastInsertRowid }`. Use `lastInsertRowid` (cast to `Number`) for the new user/session id.
- **Crypto is partly async:** `await hashPassword(pw)`, `await verifyPassword(hash, pw)`; `generateToken()` and `hashToken(raw)` are sync.
- **Timestamps:** unix epoch ms via `Date.now()`; booleans are `0`/`1` integers; `expires_at = Date.now() + config.sessionTtlSeconds * 1000`.
- **Config:** all settings via `loadConfig()`; add new ones with the `num(name, fallback)` helper in `config.ts`, never raw `process.env` in routes.
- **No test runner:** `npm run typecheck` (server `tsc --noEmit` + client `svelte-check`) is the only gate; flows are verified by curl. Keep handlers strictly typed.

## Data Flow

**Register** (`POST /api/register {token, username, password}`):
1. Validate body (all three present, non-empty; basic username/password length). Return 400 on malformed.
2. `hashToken(token)` → `SELECT * FROM invite_tokens WHERE token_hash = ?` (uses `idx_invite_tokens_token_hash`).
3. Reject (400/409) if row missing, `revoked = 1`, or `used_by` already set — invite is single-use.
4. `await hashPassword(password)`.
5. Insert user `(username, password_hash, display_name=null, created_at=Date.now(), disabled=0)`. A duplicate username trips the `UNIQUE` constraint → catch the SQLite error and return a duplicate-username conflict (409). Prefer wrapping steps 3–6 in a `db.transaction(...)` so token consumption + user creation + token-mark are atomic and the token isn't consumed if the username collides.
6. Mark the token: `UPDATE invite_tokens SET used_by = ?, used_at = ? WHERE id = ?`.
7. Issue session (see below) and return `{ session, expiresAt, user }`.

**Login** (`POST /api/login {username, password}`):
1. Validate body.
2. `SELECT * FROM users WHERE username = ?`.
3. If no user → still 401. If found, `await verifyPassword(user.password_hash, password)`; if false → 401. If `user.disabled = 1` → 401. **All three failure modes return the identical 401 body** (no user enumeration, AC #2).
4. Issue session, return `{ session, expiresAt, user }`.

**Session issuance** (shared helper):
- `raw = generateToken()`; `created_at = Date.now()`; `expires_at = created_at + config.sessionTtlSeconds*1000`.
- `INSERT INTO sessions (user_id, token_hash, created_at, expires_at, revoked) VALUES (?, hashToken(raw), ?, ?, 0)`.
- Return the **raw** token to the client (only place it is ever exposed) plus `expires_at`.

**Authenticate (Bearer)** — `authenticateSession(db, rawToken)` in `server/src/auth.ts`, wrapped by the `requireAuth` preHandler:
1. Parse `Authorization` header; require `Bearer <token>` scheme → else 401.
2. `hashToken(raw)` → `SELECT * FROM sessions WHERE token_hash = ?` (uses `idx_sessions_token_hash`).
3. Reject if missing, `revoked = 1`, or `expires_at <= Date.now()` → 401.
4. `SELECT * FROM users WHERE id = session.user_id`; reject if missing or `disabled = 1` → 401.
5. On success, return `{ user, session }`; the preHandler attaches `request.user` (the `PublicUser` shape). On any failure, reply uniform 401 and short-circuit.

**Logout** (`POST /api/logout`, behind `requireAuth`): `UPDATE sessions SET revoked = 1 WHERE id = ?` for the current session → 204/200. (The validator must surface the session row, not just the user, so logout can target the exact session.)

**Refresh** (optional `POST /api/refresh`, behind `requireAuth`): per SPEC §6 "expiry + refresh" — either extend `expires_at` on the current session or rotate (revoke old, issue new). Rotation is cleaner; document whichever in the contract.

## Decisions Made

1. **Two new modules, not one.** Put the route handlers in `server/src/routes/auth.ts` and the reusable validator/preHandler in `server/src/auth.ts`. AC #4 requires the validator be **exported for the WS gateway (story 004)**, which has no Fastify request object — so the core lookup must be a plain `authenticateSession(db, rawToken)` function decoupled from Fastify, with `requireAuth` as a thin Fastify wrapper around it. This is the single most important contract surface for downstream.
2. **`authenticateSession` returns `{ user, session } | null`** (not throwing). `null` lets both REST (uniform 401) and WS (close with auth-failure code) handle failure their own way. The `PublicUser` returned omits `password_hash` (only `id, username, display_name, created_at`).
3. **Uniform 401 for all login failures** (no-user / bad-password / disabled) — AC #2, SPEC §6. `verifyPassword` already returns `false` (never throws) on a malformed hash, supporting this. Register's duplicate-username and bad-invite-token errors are distinct (the user is mid-onboarding, enumeration is not a concern there) — return 409/400 with clear messages.
4. **Rate limiting via `@fastify/rate-limit` scoped to the auth routes only** (not global), applied to `/api/register` and `/api/login` (the unauthenticated, brute-forceable endpoints) per AC #6 / SPEC §12. Register the plugin and attach a per-route `config.rateLimit` (e.g. `max: 10, timeWindow: "1 minute"`), or register a scoped instance inside the auth plugin. Defaults can be hardcoded constants; making them env-driven (`AUTH_RATE_MAX`/`AUTH_RATE_WINDOW` via `config.ts`) is a small, spec-consistent nicety — implementer's call. `@fastify/rate-limit ^10` is the Fastify v5–compatible major and must be added to `server/package.json` (not currently installed).
5. **Keep `buildApp` synchronous if possible.** `index.ts` calls `const app = buildApp(config)` synchronously and then `await app.listen(...)`. `@fastify/rate-limit` can be registered with `void app.register(...)` exactly like the existing CORS line (Fastify defers plugin loading until `.ready()`/`.listen()`), so `buildApp` need not become async. If the implementer prefers `await app.register(...)`, they must make `buildApp` async and update `index.ts`'s call site — a contained change. Prefer the `void app.register` route to minimize blast radius.
6. **Atomic register via `db.transaction()`.** better-sqlite3 transactions are synchronous, but `hashPassword` is async — so hash the password *before* opening the transaction, then do the token-check + user-insert + token-mark synchronously inside `db.transaction(...)`. This prevents consuming an invite token when the username collides.
7. **Validation without a JSON-schema dependency.** Fastify supports route `schema` validation natively (no extra dep). Define inline JSON schemas for the request bodies to get 400s on malformed input for free, matching the no-extra-deps spirit of the repo. Manual guards are an acceptable fallback.
8. **Response shape:** `{ session: string, expiresAt: number (epoch ms), user: PublicUser }` for register & login, where `PublicUser = { id, username, displayName, createdAt }`. Document field names (camelCase in JSON vs snake_case in DB) explicitly in `contracts/auth-api.md`. The contract file is itself an acceptance criterion (AC #8).

## Open Questions

None that block planning. The only genuinely optional item is `/api/refresh` (AC marks it optional) and whether rate-limit thresholds are env-configurable — both are documented above with a recommended default and can be settled in the plan.
