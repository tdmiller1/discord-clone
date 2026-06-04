#plan

# Plan: Auth REST API (register, login, session)

## Summary
Add the unauthenticated `POST /api/register` / `POST /api/login` endpoints plus the
authenticated `POST /api/logout` / `POST /api/refresh` endpoints to the Fastify server, backed
by the story-001 `db`/`crypto` helpers. The reusable core is a framework-agnostic
`authenticateSession(db, rawToken)` validator (in `server/src/auth.ts`) wrapped by a `requireAuth`
Fastify `preHandler`, so story 004's WS gateway can reuse session validation without a Fastify
request. Rate limiting is applied to the brute-forceable register/login routes via `@fastify/rate-limit`.

## Implementation Steps

### Step 1: Add `@fastify/rate-limit` dependency
**File(s):** `server/package.json`
**Action:** modify
**Description:** Add `@fastify/rate-limit` at `^10.x` (the Fastify v5–compatible major) to
`dependencies`. All other needed deps (`@node-rs/argon2`, `better-sqlite3`, `fastify`,
`@fastify/cors`) are already present. After editing, `npm install` must be run in `server/` so the
lockfile/`node_modules` resolve before typecheck.
**Diff shape:**
- Add: `"@fastify/rate-limit": "^10.2.1"` to the `dependencies` object (keep alphabetical ordering near `@fastify/cors`).
- Remove: nothing.
- Change: nothing.

### Step 2: Add rate-limit config knobs (env-driven)
**File(s):** `server/src/config.ts`, `server/.env.example`, `SPEC.md` (§12)
**Action:** modify
**Description:** Make the auth rate-limit threshold and window env-configurable through
`loadConfig()` rather than hardcoding them in a route, consistent with the project rule that all
settings flow through `loadConfig()` (CLAUDE.md / feature constraints). Use the existing `num()`
helper. SPEC §12 mandates rate-limiting auth endpoints but does not enumerate the knob names, so
this is an additive, spec-consistent nicety — defaults match the research recommendation (10 req /
60 s). Mirror in `.env.example` and add the two vars to the SPEC §12 env list so the canonical list
stays accurate.
**Diff shape:**
- Add to `Config` interface: `authRateMax: number;` (max requests per window per IP) and
  `authRateWindowMs: number;` (window length in ms).
- Add to `loadConfig()` return: `authRateMax: num("AUTH_RATE_MAX", 10),` and
  `authRateWindowMs: num("AUTH_RATE_WINDOW_MS", 60_000),`.
- Add to `server/.env.example`: `AUTH_RATE_MAX=10` and `AUTH_RATE_WINDOW_MS=60000` with a short comment.
- Add to `SPEC.md §12` env-var list: `AUTH_RATE_MAX`, `AUTH_RATE_WINDOW_MS` (note they are optional with sane defaults).
- Remove: nothing.
- Change: nothing existing.

### Step 3: Shared auth row/response types
**File(s):** `server/src/types.ts`
**Action:** create
**Description:** Define typed row shapes and the public response shape so the synchronous
`better-sqlite3` `.get()` calls (which return `unknown`) can be cast once, centrally. Keeps `auth.ts`
and `routes/auth.ts` strictly typed under `tsc --noEmit` (the only gate). ESM module — no relative
imports needed here (pure type decls), so no `.js` specifier concerns.
**Diff shape:**
- Add: `UserRow` (`id, username, password_hash, display_name, created_at, disabled` — DB snake_case).
- Add: `SessionRow` (`id, user_id, token_hash, created_at, expires_at, revoked`).
- Add: `InviteTokenRow` (`id, token_hash, created_by, created_at, used_by, used_at, revoked`).
- Add: `PublicUser` = `{ id: number; username: string; displayName: string | null; createdAt: number }` (the camelCase API shape).
- Add: a small `toPublicUser(row: UserRow): PublicUser` mapper (snake_case → camelCase, drops `password_hash`).

### Step 4: Framework-agnostic session validator + `requireAuth` preHandler
**File(s):** `server/src/auth.ts`
**Action:** create
**Description:** The key cross-story contract surface (AC #4). Export
`authenticateSession(db, rawToken): { user: PublicUser; session: SessionRow } | null` — a plain
function that hashes the token, looks up the session by `idx_sessions_token_hash`, rejects
missing/revoked/expired, then loads the owning user and rejects missing/disabled, returning
`{ user, session }` or `null` (never throws). Story 004's WS gateway calls this directly with the
token from the connect frame — no Fastify request involved. Also export `parseBearer(header)` to
extract the raw token from an `Authorization: Bearer <token>` header (returns `null` if scheme
mismatched/absent). Then export `requireAuth(request, reply)` — a Fastify `preHandler` that parses
the header, calls `authenticateSession(request.server.db, raw)`, on `null` sends the **uniform 401**
and short-circuits, on success attaches both `request.user` (PublicUser) and `request.session`
(SessionRow). Logout/refresh need the session row, not just the user, to target the exact session.
**Diff shape:**
- Add: `import { hashToken } from "./crypto.js";` and `import type { Db } from "./db.js";` and type imports from `./types.js`, plus `import type { FastifyRequest, FastifyReply } from "fastify";`.
- Add: `export function authenticateSession(db: Db, rawToken: string): { user: PublicUser; session: SessionRow } | null`.
- Add: `export function parseBearer(authorization: string | undefined): string | null`.
- Add: `export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void>`.
- Add: a single `UNAUTHORIZED` body constant `{ error: "unauthorized" }` reused by requireAuth.

### Step 5: Auth route plugin (register / login / logout / refresh)
**File(s):** `server/src/routes/auth.ts`
**Action:** create
**Description:** A Fastify plugin (`export default async function authRoutes(app: FastifyInstance)`)
holding the four endpoints, all under the `/api` prefix declared inline on each route path. Uses
`app.db`, the crypto helpers, and the config (passed via the encapsulated instance — see Step 6 for
how config reaches the plugin). Implements the data flows from research / the story-001 contract:
- A private `issueSession(db, userId, ttlSeconds): { session: string; expiresAt: number }` helper:
  `raw = generateToken()`, `created_at = Date.now()`, `expires_at = created_at + ttl*1000`, insert
  into `sessions` with `hashToken(raw)` and `revoked = 0`, return the **raw** token + `expiresAt`.
- `POST /api/register`: validate body via inline Fastify route `schema` (string/minLength); hash
  the password with `await hashPassword(pw)` **before** opening the transaction; run a
  `db.transaction(...)` that (a) looks up the invite by `hashToken(token)`, throws a tagged error if
  missing/revoked/`used_by` set, (b) inserts the user, (c) marks the token `used_by`/`used_at`. A
  duplicate username trips the `UNIQUE` constraint inside the txn → caught and mapped to 409. On
  success, issue a session and return `201 { session, expiresAt, user }`.
- `POST /api/login`: validate body; `SELECT * FROM users WHERE username = ?`; on no-user, run
  `verifyPassword` against a dummy hash anyway (or just return 401) — but in all of {no user, bad
  password, disabled} return the identical `401 { error: "invalid_credentials" }`. On success issue
  a session and return `200 { session, expiresAt, user }`.
- `POST /api/logout` (preHandler `requireAuth`): `UPDATE sessions SET revoked = 1 WHERE id = ?`
  using `request.session.id`; return `204` (no body).
- `POST /api/refresh` (preHandler `requireAuth`): **rotate** — revoke the current session
  (`request.session.id`) and issue a fresh one for `request.session.user_id`; return
  `200 { session, expiresAt, user }`. Documented as rotation in the contract.
**Diff shape:**
- Add: imports — `type FastifyInstance` / `type FastifyPluginAsync` from `fastify`; `hashPassword`,
  `verifyPassword`, `generateToken`, `hashToken` from `./crypto.js` (note: `../crypto.js` from a
  routes subdir); `requireAuth` from `../auth.js`; types + `toPublicUser` from `../types.js`.
- Add: the four route registrations with inline `schema` for register/login bodies.
- Add: the `issueSession` helper and the register `db.transaction` block.
- Remove: nothing.
- Change: nothing existing.

### Step 6: Wire plugins into `buildApp` + Fastify type augmentation
**File(s):** `server/src/app.ts`
**Action:** modify
**Description:** Register `@fastify/rate-limit` and the auth route plugin inside `buildApp(config)`,
keeping `buildApp` **synchronous** (Decision 5) by using `void app.register(...)` exactly like the
existing CORS line — Fastify defers plugin loading until `.ready()`/`.listen()`, so `index.ts`'s
synchronous `const app = buildApp(config)` call site is untouched. Register the global
rate-limit plugin with `global: false` so it only applies where a route opts in via
`config.rateLimit`, configured from `config.authRateMax` / `config.authRateWindowMs`. Pass `config`
into the auth plugin so its handlers can read `config.sessionTtlSeconds` (and so login/register/
refresh can call `issueSession` with the TTL) — via the register options object
(`void app.register(authRoutes, { config })`) read inside the plugin from its `opts`, OR decorate
the app with config; prefer the register-options approach to avoid a new decorator. Extend the
`declare module "fastify"` block to add `requireAuth`-related request props.
**Diff shape:**
- Add: `import rateLimit from "@fastify/rate-limit";` and
  `import authRoutes from "./routes/auth.js";` and type imports (`PublicUser`, `SessionRow`) from `./types.js`.
- Add to `declare module "fastify"`: extend `FastifyRequest` with `user?: PublicUser;` and
  `session?: SessionRow;` (left optional because they're only set after `requireAuth`).
- Add inside `buildApp`, after the CORS line / db decorate:
  `void app.register(rateLimit, { global: false, max: config.authRateMax, timeWindow: config.authRateWindowMs });`
  then `void app.register(authRoutes, { config });`.
- Remove: nothing.
- Change: nothing existing (health/info routes, db decorate, onClose all stay).

### Step 7: Per-route rate-limit opt-in
**File(s):** `server/src/routes/auth.ts`
**Action:** modify (same file as Step 5; called out separately for clarity)
**Description:** Attach `config: { rateLimit: { max: cfg.authRateMax, timeWindow: cfg.authRateWindowMs } }`
to the `/api/register` and `/api/login` route definitions only (not logout/refresh, which are behind
`requireAuth`). With the global plugin registered as `global: false` (Step 6), only these two
opted-in routes are limited — satisfying AC #6 without throttling authenticated traffic.
**Diff shape:**
- Add: a `config.rateLimit` block on the register and login route option objects.
- Remove: nothing.
- Change: route option objects for register/login.

### Step 8: Author the output contract
**File(s):** `context/features/m1-auth-ws-presence/story-003-auth-rest-api/contracts/auth-api.md`
**Action:** create
**Description:** AC #8. Document every request/response JSON shape, HTTP status + error codes, the
`Authorization: Bearer <session>` scheme, and the **`authenticateSession(db, rawToken)` signature**
that story 004 (WS) consumes and story 006 (client) targets. Mirror the structure of story 001's
`contracts/data-and-crypto.md` (start with a `#contract` tag, table-driven). Explicitly call out the
camelCase-JSON vs snake_case-DB mapping (`displayName`/`createdAt`/`expiresAt`) and the uniform-401
no-enumeration guarantee on login.
**Diff shape:**
- Add: endpoint reference table (method, path, auth, request body, success status+body, error codes).
- Add: the Bearer scheme description + `authenticateSession` / `requireAuth` exported signatures for downstream.
- Add: `PublicUser` shape and the session-rotation behavior of `/api/refresh`.

## New Types / Schemas / Contracts

```ts
// server/src/types.ts
export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string | null;
  created_at: number;
  disabled: number; // 0 | 1
}
export interface SessionRow {
  id: number;
  user_id: number;
  token_hash: string;
  created_at: number;
  expires_at: number;
  revoked: number; // 0 | 1
}
export interface InviteTokenRow {
  id: number;
  token_hash: string;
  created_by: number | null;
  created_at: number;
  used_by: number | null;
  used_at: number | null;
  revoked: number; // 0 | 1
}
export interface PublicUser {
  id: number;
  username: string;
  displayName: string | null;
  createdAt: number;
}
export function toPublicUser(row: UserRow): PublicUser;

// server/src/auth.ts — the cross-story contract surface (AC #4)
export function authenticateSession(
  db: Db,
  rawToken: string,
): { user: PublicUser; session: SessionRow } | null;
export function parseBearer(authorization: string | undefined): string | null;
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void>; // Fastify preHandler; sets request.user + request.session, else uniform 401

// Fastify augmentation (server/src/app.ts)
declare module "fastify" {
  interface FastifyInstance { db: Db; }
  interface FastifyRequest { user?: PublicUser; session?: SessionRow; }
}
```

Request / response bodies (JSON):
- `POST /api/register` req: `{ token: string, username: string, password: string }`
  → `201 { session: string, expiresAt: number, user: PublicUser }`
- `POST /api/login` req: `{ username: string, password: string }`
  → `200 { session: string, expiresAt: number, user: PublicUser }`
- `POST /api/logout` req: none (Bearer) → `204` no body
- `POST /api/refresh` req: none (Bearer) → `200 { session, expiresAt, user }` (rotated)

## Configuration / Environment Changes

Two new optional, env-driven settings, added via `loadConfig()` in `server/src/config.ts` using the
existing `num()` helper, mirrored in `server/.env.example` and added to the `SPEC.md §12` env list:

| Env var | Config key | Default | Meaning |
| ------- | ---------- | ------- | ------- |
| `AUTH_RATE_MAX` | `authRateMax` | `10` | Max register/login requests per IP per window |
| `AUTH_RATE_WINDOW_MS` | `authRateWindowMs` | `60000` | Rate-limit window length in ms |

Dependency added to `server/package.json`: `@fastify/rate-limit` `^10.2.1` (Fastify v5 major). Run
`npm install` in `server/` after editing. No other new deps — request-body validation uses Fastify's
built-in route `schema` support (no JSON-schema lib).

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| REST | `POST /api/register` | `{ token, username, password }` | `201 { session, expiresAt, user }` | Consumes invite atomically; 400 malformed, 400 bad/used/revoked token, 409 dup username, 429 rate-limited |
| REST | `POST /api/login` | `{ username, password }` | `200 { session, expiresAt, user }` | Uniform `401 { error: "invalid_credentials" }` for no-user/bad-pw/disabled; 400 malformed; 429 rate-limited |
| REST | `POST /api/logout` | Bearer session | `204` | `requireAuth`; revokes the current session row |
| REST | `POST /api/refresh` | Bearer session | `200 { session, expiresAt, user }` | `requireAuth`; rotates: revoke old + issue new |
| Lib | `authenticateSession(db, rawToken)` | `Db`, raw token string | `{ user, session } \| null` | Framework-agnostic; reused by story-004 WS gateway |
| Lib | `parseBearer(authorization)` | header string \| undefined | raw token \| `null` | Extracts token from `Bearer <token>` |
| Fastify | `requireAuth` preHandler | `FastifyRequest`/`Reply` | sets `request.user`+`request.session`, else uniform 401 | Thin wrapper over `authenticateSession` |
| Decorate | `request.user`, `request.session` | — | `PublicUser?` / `SessionRow?` | Set only after `requireAuth` runs |

## Edge Cases & Gotchas

- Invalid / already-used (`used_by` set) / revoked invite token on register → reject (400, not 409) — handled in Step 5.
- Duplicate username on register → `UNIQUE` violation caught inside the transaction → 409 — handled in Step 5.
- Invite token must NOT be consumed if the username collides → password hashed before the txn, and token-check + user-insert + token-mark all inside one `db.transaction()` (synchronous) so any throw rolls back — handled in Step 5 (Decision 6).
- No user enumeration on login: no-user, bad password, and disabled user all return the identical `401 { error: "invalid_credentials" }`; `verifyPassword` returns `false` (never throws) on a malformed hash — handled in Step 5 (Decision 3).
- `buildApp` stays synchronous: rate-limit + auth plugins registered via `void app.register(...)` (deferred load), so `index.ts` is untouched — handled in Step 6 (Decision 5).
- Expired / revoked session, or session for a disabled user, presented to a `requireAuth` route → uniform 401; logout/refresh need the session row so the validator returns `{ user, session }`, not just user — handled in Step 4.
- ESM `.js` specifiers: `server/src/routes/auth.ts` imports crypto/auth/types as `../crypto.js`, `../auth.js`, `../types.js` (one dir up); `app.ts` imports `./routes/auth.js`, `./types.js` — handled in Steps 4–6.
- `better-sqlite3` `.get()` returns `unknown` → cast through `UserRow`/`SessionRow`/`InviteTokenRow` from `types.ts`; `.run().lastInsertRowid` cast via `Number(...)` for new ids — handled in Steps 3–5.
- Rate-limit must not throttle authenticated routes: global plugin registered `global: false`, only register/login opt in via `config.rateLimit` — handled in Steps 6–7.
- Timestamps are epoch ms (`Date.now()`), booleans are `0`/`1`, `expires_at = created_at + config.sessionTtlSeconds * 1000` — handled in Steps 4–5.

## Acceptance Criteria Checklist

- [ ] `POST /api/register` validates + consumes invite (hash lookup, single-use, sets `used_by`/`used_at`), rejects dup usernames, Argon2id hash, issues session, returns `{ session, expiresAt, user }` → Steps 5, 7
- [ ] `POST /api/login` verifies Argon2id, rejects disabled, issues session; uniform 401 for bad-user/bad-pw/disabled (no enumeration) → Steps 5, 7
- [ ] Session issuance stores only the token **hash** in `sessions` with `created_at`/`expires_at` (from `config.sessionTtlSeconds`) and `revoked=0`, returns raw token → Step 5 (`issueSession`)
- [ ] Reusable `Authorization: Bearer` validator: lookup by hash, not expired/revoked, user not disabled, attaches user, **exported for the WS gateway** → Step 4 (`authenticateSession` + `requireAuth`)
- [ ] `POST /api/logout` revokes the current session; `POST /api/refresh` rotates it per SPEC §6 → Step 5
- [ ] `register` + `login` are rate-limited per SPEC §12 → Steps 1, 2, 6, 7
- [ ] All routes registered inside `buildApp(config)`; `npm run typecheck` passes; flow verifiable via curl (mint → register → login → authed route → logout) → Step 6
- [ ] `contracts/auth-api.md` documents request/response shapes, error codes, and the Bearer-session scheme → Step 8
