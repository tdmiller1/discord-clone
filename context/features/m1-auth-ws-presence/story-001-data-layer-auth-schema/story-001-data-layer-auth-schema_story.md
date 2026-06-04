---
story: 001
title: Server data layer & crypto foundation
status: TODO
depends_on: []
provides_contract: contracts/data-and-crypto.md
---

#story

# Story 001: Server data layer & crypto foundation

## User Story
As a developer, I want a SQLite data layer with the auth tables plus shared crypto helpers, so that the REST API, the admin CLI, and the gateway all build on one source of truth for persistence and hashing.

## Acceptance Criteria
- [ ] `better-sqlite3` is added to `server/` dependencies; a `db` module opens/creates the SQLite file under `config.dataDir` (e.g. `<dataDir>/app.db`), creating the directory if missing.
- [ ] Schema is created idempotently on startup (`CREATE TABLE IF NOT EXISTS`) for `users`, `invite_tokens`, and `sessions` exactly per `SPEC.md §8` (column names, `UNIQUE`/nullable/defaults).
- [ ] `users.username` is `UNIQUE`; indexes exist on `invite_tokens.token_hash` and `sessions.token_hash` for hash lookups.
- [ ] Crypto helpers are exported: `hashPassword`/`verifyPassword` (Argon2id), `generateToken` (random, URL-safe), and `hashToken` (e.g. SHA-256 of the raw token) — used for **both** invite tokens and session tokens.
- [ ] The `db` handle is constructed from `Config` and passed into `buildApp` (and reachable by the CLI), not via global singletons or scattered `process.env` reads — preserving the `buildApp(config)` testability split.
- [ ] `npm run typecheck` passes; starting the server creates the db file and tables (verifiable with `sqlite3`/inspection).
- [ ] `contracts/data-and-crypto.md` documents the table shapes, the `db` accessor module API, and the hashing scheme so stories 002–004 can rely on them.

## Context
`SPEC.md §8` defines the data model; `§12` requires Argon2id passwords and hashed, single-use tokens. The server is ESM (`.js` import specifiers). Config must flow through `loadConfig()` (`config.dataDir`); the `buildApp(config)` separation (`server/src/app.ts`) must stay intact so tests can build the app without binding a port.

## Out of Scope
- `channels`, `messages`, `attachments` tables (M2/M3) — the gateway returns an empty `channels` array in M1, so these are deferred.
- Any REST routes, WS gateway, or CLI commands (later stories consume this foundation).
