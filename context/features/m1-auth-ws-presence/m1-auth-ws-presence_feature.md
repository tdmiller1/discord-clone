---
name: M1 — Auth + WS Connect + Presence
description: Token-bootstrapped accounts, login/session auth, and a live WebSocket member-presence list.
type: feature
status: planned
completed_date:
---

# Feature: M1 — Auth + WS Connect + Presence

## Problem Statement
The repo is at M0: the server exposes only `/health` and `/`, and the client is a single screen that pings it. There is no way to create accounts, authenticate, connect to the realtime gateway, or know who is online — so the admin cannot onboard the ~10 users and users cannot sign in or see presence.

## Goal
Deliver the M1 acceptance loop from `SPEC.md §14`: the admin mints an invite token via a server CLI command; a new user registers in the Tauri client (server URL + token + username + password), logs in, and the client connects to the WebSocket gateway and renders the member list updating **online/offline live**. The session token persists in the OS keychain so a relaunch stays logged in, and the admin can revoke a user to kill their sessions.

## Constraints
- **Server is ESM** (`"type": "module"`, NodeNext): relative TS imports must carry the `.js` extension.
- New routes/plugins go **inside `buildApp(config)`** (`server/src/app.ts`); `index.ts` stays listen + signal-handling only (a CLI gets its own entry, not `index.ts`).
- All settings flow through **`loadConfig()`** (`server/src/config.ts`) + `server/.env.example` (`SPEC.md §12`) — no scattered `process.env` reads.
- Persistence is **`better-sqlite3`**, a single SQLite file under `DATA_DIR`. Passwords use **Argon2id**; invite tokens and session tokens are random and **stored hashed**; invite tokens are **single-use**.
- **Rate-limit** auth endpoints; size-limit WS frames; design for **≤10 concurrent clients** (in-memory presence map, no broker).
- Frontend uses **Svelte 5 runes** (`$state`, …). The session **token** (never the password) is stored in the **OS keychain** via Tauri Rust commands, with the matching grant in `capabilities/default.json`.
- WS uses the **`{ "op", "d" }` JSON envelope** (`SPEC.md §7`); the client authenticates **on connect** with the session token.
- **No test runner exists** — `npm run typecheck` is the only static gate. Acceptance criteria must be verifiable via typecheck + curl/`wscat` + running the client.

## Non-Goals
- Text channels & messages (M2), images (M3), voice/SFU (M4) — including `message.send`/`message.create`/`channel.create`/`voice.*`.
- Roles / granular permissions — one flat member role plus a CLI-level admin.
- Password reset, email, account recovery.
- Markdown / mentions.
- The `channels` array in the `ready` payload is an **empty placeholder** until M2; M1 ships user + members + live presence only.
- HTTPS/WSS termination (fronted by Caddy in deploy per `SPEC.md §12`; dev uses `http`/`ws`).

## Known Edge Cases
- Invite token invalid / already used / revoked → register rejected.
- Duplicate username on register → rejected.
- Wrong password or disabled user on login → uniform 401 (no user enumeration).
- Expired/revoked session presented to REST → 401; presented on WS connect → socket closed with a defined auth-failure code (no `ready`).
- `server revoke-user` disables the account and kills all its sessions; an open WS for that user is dropped and presence flips offline.
- Abrupt WS disconnect (network drop / app close) → heartbeat detects it, server marks the user offline and broadcasts `presence.update`.
- Multiple devices/sessions per user (reinstall, two machines) — a user is "online" if ≥1 socket is open.
- Client relaunch with a stored-but-expired session → falls back to the login screen and clears the stale token.

## User Stories

| # | Story Directory | Title | Status |
|---|----------------|-------|--------|
| 1 | story-001-data-layer-auth-schema | Server data layer & crypto foundation | TODO |
| 2 | story-002-admin-cli-tokens | Admin CLI: mint-token & revoke-user | TODO |
| 3 | story-003-auth-rest-api | Auth REST API (register, login, session) | TODO |
| 4 | story-004-ws-gateway-presence | WebSocket gateway & presence | TODO |
| 5 | story-005-client-keychain-shell | Client: Tauri keychain session storage | TODO |
| 6 | story-006-client-auth-screens | Client: register & login screens | TODO |
| 7 | story-007-client-presence-ui | Client: gateway connection & live presence | TODO |
