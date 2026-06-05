---
name: M5 — Release & docs
description: Tag-driven release that publishes the server OCI image to a registry and attaches the Windows/Linux installers to a GitHub Release, plus a production deploy compose (pull image + TLS) and a verified end-to-end README deploy runbook with operations docs.
type: feature
status: planned
completed_date:
---

# Feature: M5 — Release & docs

## Problem Statement
M0–M4 produced a working product — auth/presence, text channels, inline images, and SFU voice — but **nothing ships**. The admin SPEC promises (`§1`, `§5`) three downloadable, low-effort artifacts: a server **image** anyone can `docker run`, and **Windows/Linux installers** anyone can download and install. Today none of that is published: CI (`.github/workflows/ci.yml`) only runs on `push`/`pull_request`, tags the server image `discord-clone-server:ci` and **never pushes it**, and uploads the `.msi`/`.exe`/`.AppImage`/`.deb` as **ephemeral workflow artifacts** (`if-no-files-found: warn`) that vanish — there are **no git tags and no GitHub Release**. The only compose file (`docker-compose.yml`) is a *dev* file (`build: ./server`, `PUBLIC_HOST: localhost`, no TLS), the version is **incoherent** (root/server/client `package.json` say `0.2.0` but `client/src-tauri/tauri.conf.json` says `0.1.0`), and the `README.md` is a 20-line stub with **zero deploy instructions** — an admin handed this repo cannot stand the server up or get a client onto a teammate's machine.

## Goal
Deliver the M5 acceptance loop from `SPEC.md §14`: **a tagged release publishes the server image + Windows/Linux installers, and the README deploy steps are verified end-to-end.** Concretely — pushing a `vX.Y.Z` git tag triggers CI to (1) **build and push the server OCI image** to a registry (GHCR) tagged with the release version and `latest`, and (2) **build the Tauri installers** on ubuntu + windows and **attach them to a GitHub Release** for that tag (the release **fails** rather than publishing empty if an installer is missing). The repo carries a **single coherent version** derived from the tag. A **production** `docker-compose` (or documented run) **pulls the published image** instead of building from source, sets a real `PUBLIC_HOST`, exposes the media UDP range, and fronts HTTPS/WSS with **Caddy** for automatic TLS (`§12`). The `README.md` carries a complete, **verified** admin runbook — deploy the server, get TLS, **mint an invite token** (`server mint-token`), download + install the client from the Release, register/login, and confirm text + images + voice work — backed by a `docs/DEPLOYMENT.md` operations reference (env vars, `/data` backup, user/token revoke, voice/ICE troubleshooting).

## Constraints
- **Tag-triggered publish, not push-triggered (`SPEC.md §5`, `§14`).** Publishing must key off an annotated/lightweight **`v*` tag** (e.g. `v0.2.0`), not every commit. The existing PR/push CI (build + health smoke + `tauri build`) stays as the **per-change gate**; the release path is **additive** — do not weaken or delete the current `ci.yml` jobs. CI matrix stays **windows-latest + ubuntu-latest + image build** (`§5`).
- **Single source of truth for the version, derived from the tag.** Reconcile the existing drift (`tauri.conf.json` `0.1.0` vs everything else `0.2.0`) and make the release version come from the **git tag** so the image tag, the GitHub Release name, and the installer/`tauri.conf.json` version all agree. No hand-maintained version in three places that can silently diverge.
- **Server image is glibc/amd64 (`server/Dockerfile`).** The runtime stage is deliberately `node:24-bookworm-slim` (NOT alpine/musl) because **mediasoup's worker is a glibc-linked native binary** (`§11`); `better-sqlite3` is compiled in the build stage. The published image must preserve this — **amd64 / glibc only** (multi-arch is a non-goal). Reuse the existing multi-stage `Dockerfile` and `HEALTHCHECK`; do not author a second one.
- **Reuse the established deploy contract — don't invent new config.** All server config is env-driven via `loadConfig()` (`server/src/config.ts`); the canonical env list is `SPEC.md §12` + `server/.env.example`. The prod compose and docs reference **those** names (`PUBLIC_HOST`, `HTTP_PORT`, `RTC_MIN_PORT`/`RTC_MAX_PORT`, `DATA_DIR=/data`, `MAX_UPLOAD_MB`, `SESSION_TTL`, `AUTH_RATE_*`). Volumes: **`/data`** (SQLite + images). Ports: HTTPS/WSS + the **UDP media range**, which must stay in sync between compose port mapping and `RTC_MIN_PORT`–`RTC_MAX_PORT` (CLAUDE.md gotcha; note the current dev drift — compose maps `40000-40010` while `.env.example` says `40000-40100`).
- **TLS via Caddy in front (`SPEC.md §12`).** HTTPS/WSS is **required**; the recommended path is fronting with **Caddy** for automatic Let's Encrypt. The reverse proxy must pass the **WebSocket upgrade** through to the gateway, and the **media UDP range must reach the container directly** (Caddy does not proxy the SFU's UDP media — it goes host→container). The server's `PUBLIC_HOST` is the **ICE announce address** (`§11`) and must be the real public hostname/IP, never `localhost`, in production.
- **Admin onboarding is the existing CLI (`server/src/cli.ts`).** The runbook uses the real commands — `docker exec <ctr> server mint-token`, `revoke-user <username>`, `revoke-token <id>` — and the **first-boot admin bootstrap credential printed to logs** (`§12`). Do not invent new admin endpoints; document what exists.
- **Docs are the deliverable here — they must be true and verified.** This milestone ships **prose + CI config + a compose/Caddy file**, with essentially no application TypeScript. Every command in the README must be **runnable as written** against the published image; "verified end-to-end" (`§14`) means the author actually walked the deploy on a clean host (or a faithful local stand-in) and the steps produced a working server + connected client. **No test runner exists** — `npm run typecheck` remains the only static gate; verification of this milestone is the end-to-end deploy walkthrough, not unit tests.

## Non-Goals
- **Auto-update / Tauri updater + update signing.** The client `identifier` exists but no `updater` is configured and there is no signing key infrastructure; shipping signed delta updates is out of scope. Users download a fresh installer from the Release.
- **Code signing / notarization** (Windows Authenticode, Apple notarization). Binaries ship **unsigned**; the README simply documents the expected SmartScreen/"unknown publisher" warning. Acquiring certs is out of scope.
- **macOS client.** SPEC ships **Windows + Linux only** (`§5`, README); no `.dmg`/macOS in the matrix.
- **Multi-arch images (arm64).** The image is amd64/glibc only (mediasoup worker constraint above). No `buildx` multi-platform manifest in v1.
- **Alternate distribution channels** — Homebrew, winget, Flatpak, Snap, app stores, a download website. The Release page + the GHCR image are the distribution surface.
- **Release-notes / changelog automation, semantic-release, conventional-commit tooling.** A human writes the tag and (optionally) the release body. No automated version bumping from commit messages.
- **Staging environments, blue/green, rolling deploy, orchestration (k8s/Swarm), monitoring/observability stacks.** Single-host `docker compose` per `SPEC.md §2`.
- **Hosting the docs site / publishing to a docs host.** Markdown in-repo (`README.md`, `docs/DEPLOYMENT.md`) is the deliverable.

## Known Edge Cases
- **Tag pushed without a version bump:** today `tauri.conf.json` (`0.1.0`) lags `package.json` (`0.2.0`) — a release must derive the version from the tag and **fail or correct** the mismatch rather than ship an installer stamped with the wrong version.
- **Re-running / re-pushing a release (idempotency):** re-running the workflow for an existing tag, or moving a tag, must not crash on "release already exists" or duplicate/garble assets — assets upload cleanly (clobber or skip), and the GHCR tag is overwritten predictably.
- **Missing installer in the matrix:** the current `if-no-files-found: warn` silently tolerates an empty upload — for a **release** that must be an **error**: do not publish a Release missing the Windows or Linux installer.
- **GHCR auth & visibility:** the push needs `packages: write` permission and the workflow `GITHUB_TOKEN`; first publish of a package may default to **private** — the docs must say how the image is named (`ghcr.io/<owner>/discord-clone-server:<version>`) and how to make/keep it pullable.
- **Image arch mismatch on the host:** the published amd64/glibc image won't run on an arm64 host — document the supported arch (mediasoup glibc-worker constraint), don't silently produce a broken pull.
- **`PUBLIC_HOST=localhost` in production:** voice silently fails because ICE announces `localhost`; the runbook must call out setting the real public hostname/IP, and that the **UDP media range** must be open in the host firewall and mapped wide enough for ≤10 clients.
- **WSS upgrade through the proxy:** a misconfigured Caddy that doesn't forward the `Upgrade`/`Connection` headers breaks the WS gateway (and voice signaling) even though `/health` looks fine — the Caddyfile and README must get the WebSocket passthrough right.
- **`/data` backup/restore consistency:** SQLite + image files live in the `/data` volume; the ops doc must give a safe backup approach (the DB is the source of truth for messages/users/sessions; images are files) and note nothing voice-related is persisted (`§8`).
- **Client trusting the server URL / no-TLS fallback:** if the admin skips TLS, the client connecting over plain `ws://`/`http://` — document that HTTPS/WSS is required (`§12`) and what breaks without it.
- **Unsigned-binary warnings:** Windows SmartScreen and Linux "untrusted AppImage" prompts are expected (no signing); the README sets that expectation so users don't think the download is broken.
- **`docker-compose.yml` (dev) vs the prod compose:** two compose files must not confuse the admin — the dev one builds from source for contributors; the prod one pulls the published image. Keep their purpose labeled and their env/port mappings internally consistent.

## User Stories

| # | Story Directory | Title | Status |
|---|----------------|-------|--------|
| 1 | story-001-release-versioning | Single source-of-truth version derived from the git tag | TODO |
| 2 | story-002-release-server-image | Tag-triggered: build & push the server image to GHCR | TODO |
| 3 | story-003-release-client-installers | Tag-triggered: attach Windows/Linux installers to a GitHub Release | TODO |
| 4 | story-004-deploy-compose-tls | Production deploy compose (pull image) + Caddy TLS | TODO |
| 5 | story-005-readme-deploy-ops-docs | Verified README deploy runbook + operations docs | TODO |
