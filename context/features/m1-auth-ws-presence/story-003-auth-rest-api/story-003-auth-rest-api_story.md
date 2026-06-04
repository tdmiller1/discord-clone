---
story: 003
title: Auth REST API (register, login, session)
status: TODO
depends_on: [001]
provides_contract: contracts/auth-api.md
---

#story

# Story 003: Auth REST API (register, login, session)

## User Story
As a user, I want to register with an invite token and log in with my username/password, so that I receive a session usable for both the REST API and the WebSocket gateway.

## Acceptance Criteria
- [ ] `POST /api/register {token, username, password}`: validates + **consumes** the invite token (hash lookup; must be unused & not revoked → set `used_by`/`used_at`), rejects duplicate usernames, creates the user with an Argon2id hash, issues a session, and returns `{ session, expiresAt, user }`.
- [ ] `POST /api/login {username, password}`: verifies the password (Argon2id), rejects disabled users, issues a session. Bad username / bad password / disabled all return a **uniform 401** (no user enumeration).
- [ ] Session issuance stores only the session **token hash** in `sessions` with `created_at`/`expires_at` (from `config.sessionTtlSeconds`) and `revoked=0`, returning the raw token to the client.
- [ ] A reusable auth decorator/`preHandler` validates `Authorization: Bearer <session>` — looks up by hash, checks not expired, not revoked, user not disabled, attaches the user — and is **exported for reuse by the WS gateway** (story 004).
- [ ] `POST /api/logout` revokes the current session; (optional) `POST /api/refresh` extends/rotates it per `SPEC.md §6`.
- [ ] `register` and `login` are **rate-limited** (e.g. `@fastify/rate-limit`) per `SPEC.md §12`.
- [ ] All routes are registered inside `buildApp(config)`; `npm run typecheck` passes; the full flow is verifiable via curl (mint a token via story 002 → register → login → call an authed route → logout).
- [ ] `contracts/auth-api.md` documents request/response shapes, error codes, and the Bearer-session scheme for the client (story 006) and gateway (story 004).

## Context
`SPEC.md §6` (auth flows), `§7` (the Bearer session is sent on REST and on WS connect), `§12` (rate-limit, hashed sessions). Reuses the `db` + crypto helpers from story 001. CORS is already permissive in `app.ts`.

## Out of Scope
- Channel/message/image endpoints (M2/M3).
- Password reset.
- The WS gateway itself — story 004 consumes the session validator exported here.
