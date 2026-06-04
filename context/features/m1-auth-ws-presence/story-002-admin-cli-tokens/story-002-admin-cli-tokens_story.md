---
story: 002
title: "Admin CLI: mint-token & revoke-user"
status: TODO
depends_on: [001]
provides_contract:
---

#story

# Story 002: Admin CLI — mint-token & revoke-user

## User Story
As the server admin, I want CLI commands to mint single-use invite tokens and to revoke users, so that I can onboard and offboard the ~10 users out-of-band (`docker exec`).

## Acceptance Criteria
- [ ] A CLI entry (invoked e.g. as `server mint-token` / `node dist/cli.js mint-token`, with an npm script) generates a random invite token, stores **only its hash** in `invite_tokens` (unused, not revoked), and prints the raw token **once** to stdout.
- [ ] `server revoke-user <username>` sets `users.disabled` and revokes all that user's `sessions` (`revoked=1`), printing a confirmation; an unknown username exits non-zero with a clear message.
- [ ] (Nice-to-have) `server revoke-token <id>` revokes an unused invite token.
- [ ] Commands reuse the `db` + crypto helpers from story 001 — no duplicated hashing logic — and run against the **same `DATA_DIR`/SQLite file** the server uses, so a token minted via `docker exec` is immediately usable by the running server.
- [ ] The CLI lives in its **own entry** (e.g. `server/src/cli.ts`), not in `index.ts` (which stays listen + signal-handling only per CLAUDE.md); `--help` lists the commands.
- [ ] `npm run typecheck` passes; mint→register→login round-trips end-to-end once story 003 lands (verifiable via curl).

## Context
`SPEC.md §6`: the admin mints tokens via `docker exec <ctr> server mint-token`; revoke disables the account and kills its sessions. `§8` defines `invite_tokens`/`users`/`sessions`; `§12` requires hashed, single-use tokens. The admin's authority is shell/`docker exec` access — there is **no** HTTP admin mint endpoint in v1.

## Out of Scope
- Any HTTP/REST admin endpoints or admin web UI.
- The first-boot bootstrap-credential mechanism beyond an optional log notice — the CLI is the admin surface.
