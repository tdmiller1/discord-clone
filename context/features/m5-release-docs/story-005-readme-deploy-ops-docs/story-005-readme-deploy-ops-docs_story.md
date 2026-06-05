---
story: 005
title: Verified README deploy runbook + operations docs
status: TODO
depends_on: [002, 003, 004]
provides_contract:
---

#story

# Story 005: Verified README deploy runbook + operations docs

## User Story
As an admin who just cloned this repo, I want a complete, verified deploy runbook so that I can stand up the server with TLS, invite users, and confirm text/images/voice work end-to-end without reverse-engineering the code.

## Acceptance Criteria
- [ ] `README.md` is expanded from its current stub into a **deploy runbook** that walks, in order: (1) deploy the server via the **production compose** pulling the published image (story 004 + 002), (2) get **HTTPS/WSS** via Caddy, (3) **mint an invite token** with the real CLI (`docker exec <ctr> server mint-token`) and find the **first-boot admin bootstrap credential in the logs** (`SPEC.md §12`), (4) **download + install the client** from the GitHub Release (story 003's asset names), (5) register → login → connect, (6) confirm text channels, inline images, and **voice** work.
- [ ] Every command is **runnable as written** against the published image/Release (correct `ghcr.io/<owner>/...` path, correct asset filenames, correct env vars) — no placeholders that don't resolve, no commands for endpoints/flags that don't exist.
- [ ] The runbook calls out the production gotchas surfaced in the feature: set a **real `PUBLIC_HOST`** (voice fails on `localhost`), open the **UDP media range** in the host firewall, expect **unsigned-binary warnings** (Windows SmartScreen / untrusted AppImage — no code signing), and that **HTTPS/WSS is required** (`§12`).
- [ ] An operations doc (`docs/DEPLOYMENT.md` or `docs/OPERATIONS.md`) covers: the **env var reference** (cross-linking `SPEC.md §12` / `server/.env.example`), **`/data` backup & restore** (SQLite DB + image files; nothing voice-related is persisted, `§8`), **user/token management** (`revoke-user`, `revoke-token`), the **supported image arch** (amd64/glibc), and **voice/ICE troubleshooting** (`PUBLIC_HOST`/`announcedIp`, UDP range, WSS-upgrade-through-proxy).
- [ ] **Dev vs prod is unambiguous:** the README points contributors to `docs/DEVELOPMENT.md` + the root dev compose for building from source, and admins to the prod compose for deploying the published image — no confusion between the two.
- [ ] **Verified end-to-end (`SPEC.md §14` acceptance):** the author actually executes the runbook on a clean host (or a faithful local stand-in) and confirms a working server + a connected client; the story's DONE notes record what was run and the outcome.
- [ ] `npm run typecheck` still passes (docs-only change touches no TypeScript, but the gate must stay green).

## Context
`README.md` is a ~20-line high-level stub with **no deploy steps**; `docs/DEVELOPMENT.md` covers only the dev/build workflow. `SPEC.md §14 M5` acceptance is explicitly *"README deploy steps verified end-to-end."* This is the capstone story: it consumes the published image (002), the Release installers (003), and the prod compose + TLS (004) and turns them into a runbook an admin can follow, plus an ops reference. It is docs-only and depends on the three publishing/deploy stories being real so the documented commands actually work.

## Out of Scope
- Building the CI release jobs or the prod compose themselves (stories 002–004) — this story documents and verifies them.
- A hosted docs site / publishing docs externally (feature non-goal) — in-repo Markdown only.
- Auto-update and code-signing instructions beyond noting the expected unsigned-binary warnings (feature non-goals).
