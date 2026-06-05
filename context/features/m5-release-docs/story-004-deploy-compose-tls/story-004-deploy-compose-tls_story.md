---
story: 004
title: Production deploy compose (pull image) + Caddy TLS
status: TODO
depends_on: [002]
provides_contract: contracts/deploy-compose.md
---

#story

# Story 004: Production deploy compose (pull image) + Caddy TLS

## User Story
As an admin standing up the server, I want a production compose that pulls the published image and fronts it with automatic TLS so that one `docker compose up -d` gives me a working HTTPS/WSS server with voice, without building from source or hand-rolling certificates.

## Acceptance Criteria
- [ ] A **production** compose artifact (e.g. `deploy/docker-compose.yml` + `deploy/.env.example`, leaving the root dev `docker-compose.yml` for contributors) **pulls the published image** (`image: ghcr.io/<owner>/discord-clone-server:<version|latest>`, story 002's contract) instead of `build: ./server`.
- [ ] It sets production-appropriate env from `loadConfig()`/`SPEC.md §12`: a **real `PUBLIC_HOST`** (the ICE announce address — never `localhost`), `DATA_DIR=/data` on a named volume, `MAX_UPLOAD_MB`, `SESSION_TTL`, and `RTC_MIN_PORT`/`RTC_MAX_PORT`. Values come from an env file, not hard-coded.
- [ ] The **UDP media range is exposed** and the compose **port mapping matches `RTC_MIN_PORT`–`RTC_MAX_PORT`** (CLAUDE.md gotcha); the dev drift (compose `40000-40010` vs `.env.example` `40000-40100`) is resolved to a single consistent range with a comment tying the two together.
- [ ] **TLS via Caddy (`SPEC.md §12`):** a Caddy service + `Caddyfile` (or clearly documented external reverse proxy) terminates HTTPS and reverse-proxies to the server, **passing the WebSocket upgrade through** so the gateway and voice signaling work over WSS. The Caddyfile notes that the **media UDP range bypasses Caddy** and must reach the container directly.
- [ ] The compose is internally consistent and labeled as the **production** file (distinct purpose from the dev compose), and `/data` is a persistent named volume so SQLite + images survive restarts.
- [ ] Verified to start: bringing the stack up serves `/health` over the proxy and the WS gateway accepts a connection (a real public hostname/cert is environment-dependent and may be documented rather than CI-tested).
- [ ] `contracts/deploy-compose.md` records: the canonical prod compose + Caddyfile shape, the env vars an admin must set (esp. `PUBLIC_HOST` and the UDP range), and the TLS/WSS/media-port topology — for story 005's runbook.

## Context
The only compose today (`docker-compose.yml`) is a **dev** file: `build: ./server`, `PUBLIC_HOST: localhost`, no TLS, UDP `40000-40010`. `SPEC.md §5` calls for the image + `docker-compose.yml` with a `/data` volume and the HTTPS/WSS + media-UDP ports; `§12` recommends Caddy for automatic Let's Encrypt and notes WebRTC media is DTLS-SRTP. `§11` makes `PUBLIC_HOST` the ICE announce address. This story turns "we have an image" (story 002) into "an admin can deploy it with TLS." Depends on story 002 for the published image path.

## Out of Scope
- The README walkthrough and operations doc that *use* this compose (story 005).
- The image build itself (story 002) and the installers (story 003).
- Non-Caddy proxies as the primary path, k8s/Swarm/orchestration, staging/blue-green (feature non-goals) — Caddy + single-host compose only, though a "bring your own cert/proxy" note is fine.
