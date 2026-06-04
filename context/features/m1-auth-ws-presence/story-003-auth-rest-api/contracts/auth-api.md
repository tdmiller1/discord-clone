#contract

# Contract: Auth REST API & session validator (story 003)

Authoritative interface for the M1 authentication surface (SPEC.md §6, §7, §12).
Story 004 (WS gateway) consumes the exported `authenticateSession(db, rawToken)`
validator; story 006 (client) targets the REST endpoints and the Bearer scheme.

All modules are ESM with `.js` import specifiers. Routes are registered inside
`buildApp(config)` (`server/src/app.ts`) via `void app.register(authRoutes, { config })`.
Builds on story 001's `db`/`crypto` layer (`contracts/data-and-crypto.md`).

## JSON conventions

- Timestamps are **unix epoch milliseconds** (`Date.now()`).
- DB columns are snake_case; API JSON is **camelCase** (`displayName`, `createdAt`, `expiresAt`).
- Booleans are stored as `0`/`1` integers in the DB but never appear in API responses.

## `PublicUser` shape

The only user shape ever returned to clients — `password_hash` and `disabled` are
omitted.

```jsonc
{
  "id": 1,                 // number
  "username": "alice",     // string
  "displayName": null,     // string | null
  "createdAt": 1780610454376 // number (epoch ms)
}
```

TypeScript (`server/src/types.ts`):

```ts
export interface PublicUser {
  id: number;
  username: string;
  displayName: string | null;
  createdAt: number;
}
```

## Session response shape

`POST /api/register`, `/api/login` and `/api/refresh` all return the same body:

```jsonc
{
  "session": "QWx...",          // string — RAW opaque token, shown to the client ONCE
  "expiresAt": 1781215254376,   // number — epoch ms (createdAt + SESSION_TTL*1000)
  "user": { /* PublicUser */ }
}
```

Only `hashToken(session)` (SHA-256 hex) is ever persisted server-side, in
`sessions.token_hash`. The raw `session` value is what the client stores (Tauri
keychain) and presents as the Bearer credential on REST and on WS connect.

## Endpoint reference

| Method | Path            | Auth   | Request body                              | Success            | Error statuses                                                              |
| ------ | --------------- | ------ | ----------------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| POST   | `/api/register` | none   | `{ token, username, password }`           | `201` session body | `400` malformed, `400` `invalid_token`, `409` `username_taken`, `429`       |
| POST   | `/api/login`    | none   | `{ username, password }`                  | `200` session body | `400` malformed, `401` `invalid_credentials`, `429`                         |
| POST   | `/api/logout`   | Bearer | none                                      | `204` (no body)    | `401` `unauthorized`                                                        |
| POST   | `/api/refresh`  | Bearer | none                                      | `200` session body | `401` `unauthorized`                                                        |

### `POST /api/register`

Request:

```jsonc
{
  "token": "raw-invite-token", // string, required, minLength 1
  "username": "alice",          // string, required, 1..64
  "password": "hunter2hunter2"  // string, required, 8..256
}
```

Behavior: hashes the password (Argon2id), then **atomically** (one
`db.transaction`): looks up the invite by `hashToken(token)`; rejects if missing,
`revoked = 1`, or already `used_by` set; inserts the user (`disabled = 0`); marks
the token `used_by`/`used_at`. The invite token is **not** consumed if the username
collides (the transaction rolls back). On success, issues a session and returns
`201` with the session body.

Errors:

- `400 { "error": "Bad Request" }` — malformed body (Fastify schema validation:
  missing field, wrong type, password < 8 chars, unknown property).
- `400 { "error": "invalid_token" }` — invite token unknown, revoked, or already used.
- `409 { "error": "username_taken" }` — username already exists (`UNIQUE` violation).
- `429` — rate limit exceeded (see Rate limiting).

### `POST /api/login`

Request:

```jsonc
{ "username": "alice", "password": "hunter2hunter2" }
```

Behavior: looks up the user by username and verifies the password (Argon2id). On
success, issues a session and returns `200` with the session body.

**Uniform 401 (no user enumeration):** unknown username, wrong password, and a
`disabled` account all return the identical body:

```jsonc
{ "error": "invalid_credentials" }
```

Errors:

- `400 { "error": "Bad Request" }` — malformed body.
- `401 { "error": "invalid_credentials" }` — any auth failure.
- `429` — rate limit exceeded.

### `POST /api/logout`

Bearer-authenticated. Revokes the **current** session (`UPDATE sessions SET
revoked = 1 WHERE id = <current session id>`). Returns `204` with no body.
Returns `401 { "error": "unauthorized" }` if the Bearer token is missing/invalid.

### `POST /api/refresh`

Bearer-authenticated. **Rotates** the session: revokes the current session and
issues a fresh one for the same user (atomically, in one `db.transaction`).
Returns `200` with a new session body (new `session` token + `expiresAt`). The old
raw token is no longer valid after a successful refresh. Returns
`401 { "error": "unauthorized" }` if the presented Bearer token is invalid.

## Bearer session scheme

Authenticated requests (and the WS connect frame in story 004) carry:

```
Authorization: Bearer <raw-session-token>
```

The scheme keyword is case-insensitive (`bearer` accepted); exactly one
space-separated token is expected. A missing header, wrong scheme, or empty token
yields a uniform `401 { "error": "unauthorized" }`.

## Exported session validator (consumed by story 004)

`server/src/auth.ts`:

```ts
import type { Db } from "./db.js";
import type { PublicUser, SessionRow } from "./types.js";

/**
 * Framework-agnostic. Hashes the raw token, looks up the session by
 * idx_sessions_token_hash, rejects missing/revoked/expired sessions, then loads
 * the owning user and rejects a missing/disabled account. Never throws.
 */
export function authenticateSession(
  db: Db,
  rawToken: string,
): { user: PublicUser; session: SessionRow } | null;

/** Extracts the token from an `Authorization: Bearer <token>` header, else null. */
export function parseBearer(authorization: string | undefined): string | null;

/**
 * Fastify preHandler. On success sets request.user (PublicUser) and
 * request.session (SessionRow); on failure replies with a uniform 401 and
 * short-circuits.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void>;
```

`SessionRow` (from `server/src/types.ts`, mirrors the `sessions` table):

```ts
export interface SessionRow {
  id: number;
  user_id: number;
  token_hash: string;
  created_at: number;
  expires_at: number;
  revoked: number; // 0 | 1
}
```

**Story 004 usage:** call `authenticateSession(db, tokenFromConnectFrame)` directly
(no Fastify request needed). A `null` return means reject the WS connection with an
auth-failure close code; a non-null return gives you the `PublicUser` to attach to
the connection and the `SessionRow` if you need the exact session.

## Fastify request augmentation

`server/src/app.ts` adds (only set after `requireAuth` runs on a route):

```ts
declare module "fastify" {
  interface FastifyRequest {
    user?: PublicUser;
    session?: SessionRow;
  }
}
```

## Rate limiting

`@fastify/rate-limit` is registered non-global (`global: false`); only
`/api/register` and `/api/login` opt in via their route `config.rateLimit`. Limits
are env-driven (SPEC.md §12):

| Env var               | Config key         | Default | Meaning                                 |
| --------------------- | ------------------ | ------- | --------------------------------------- |
| `AUTH_RATE_MAX`       | `authRateMax`      | `10`    | Max register/login requests per IP/window |
| `AUTH_RATE_WINDOW_MS` | `authRateWindowMs` | `60000` | Window length in ms                     |

Exceeding the limit returns `429 Too Many Requests` (with the standard
`@fastify/rate-limit` body and `retry-after`/`x-ratelimit-*` headers). Logout and
refresh are not rate-limited.
