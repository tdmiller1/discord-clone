# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-hosted, "no-fluff" Discord-server clone: one admin runs a single Docker server; up to ~10 users connect with a Tauri desktop client (text channels, inline images, one WebRTC voice channel). **`SPEC.md` is the source of truth** — it defines the realtime protocol, auth flows, SQLite data model, and the M0–M5 milestone roadmap. Read the relevant `SPEC.md` section before implementing a feature; the code is built milestone by milestone against it.

The repo is currently at **M0 (scaffold)**: the server exposes only `/health` and `/` info routes; the client is a single Svelte screen that pings the server. Auth, channels, messages, images, the WebSocket gateway, and the SFU do not exist yet — they arrive in M1–M4 (`SPEC.md §14`).

## Commands

Run from the repo root (these delegate into `server/` and `client/` via `npm --prefix`):

```bash
npm run dev:server     # tsx watch on the Fastify server
npm run dev:client     # tauri dev — native window (needs Rust + system deps)
npm run build:server   # tsc -> server/dist
npm run build:client   # vite build -> client/dist
npm run typecheck      # server `tsc --noEmit` + client `svelte-check` — the ONLY static check
npm run docker:up      # docker compose up -d --build
npm run docker:down
```

Frontend-only (in a browser, no Rust needed): `cd client && npm run dev` (Vite on :1420).
Verify the server: `curl http://localhost:8080/health`.

There is **no test runner configured yet** — `npm run typecheck` is the only gate. CI (`.github/workflows/ci.yml`) additionally builds the Docker image and runs `tauri build` on ubuntu + windows. `docs/DEVELOPMENT.md` has the full prerequisite/setup list (Node ≥20, Docker, Rust + Tauri Linux libs).

## Architecture

Monorepo, two deployables plus the SQLite/image volume:

- **`server/`** — Node + TypeScript backend, shipped as the Docker image. Will own the REST API, the WebSocket gateway (`{ "op": ..., "d": ... }` JSON envelopes, `SPEC.md §7`), the mediasoup SFU (server-routed WebRTC audio, `§11`), SQLite via `better-sqlite3`, and Argon2 password hashing. Stack chosen in `SPEC.md §13`; most of these deps aren't installed yet.
- **`client/`** — Tauri desktop app. `src/` is the Svelte 5 + TS webview frontend (owns all UI and WebRTC via `getUserMedia`/`RTCPeerConnection`); `src-tauri/` is the thin Rust shell (OS keychain for the session token, window, packaging). Build outputs: `.msi`/`.exe` (Windows), `.AppImage`/`.deb` (Linux).

Key flows to know before touching auth or voice: token-bootstrapped accounts (admin mints an invite token → client registers username+password → logs in → opaque server-side session, revocable) in `SPEC.md §6`; SFU-lite voice (clients publish an Opus track, server forwards to others — no client mesh) in `§11`. The SQLite schema is `§8`.

### Conventions & gotchas

- **The server is ESM** (`"type": "module"`, `moduleResolution: NodeNext`). Relative imports in TypeScript source must include the `.js` extension (e.g. `import { buildApp } from "./app.js"`), even though the file on disk is `.ts`. Match this when adding modules.
- **`buildApp(config)` is deliberately separated from `index.ts`** (`server/src/app.ts`) so the app can be constructed in tests without binding a port. Add routes/plugins inside `buildApp`; keep `index.ts` to listen + signal handling only.
- **All server config is env-driven** through `loadConfig()` in `server/src/config.ts` — add new settings there, not via scattered `process.env` reads. The canonical env var list lives in `SPEC.md §12` and `server/.env.example`.
- The frontend uses **Svelte 5 runes** (`$state`, etc.), not the older store/`export let` style.
- Voice/SFU needs the UDP media port range (`RTC_MIN_PORT`–`RTC_MAX_PORT`) exposed; keep `docker-compose.yml` port mapping in sync with those env vars.

## Story pipeline (optional)

`scripts/` and `.claude/commands/automated/` scaffold the `/engineering-manager` research→plan→implement→validate workflow: stories carry `depends_on`/`provides_contract` frontmatter and `scripts/build_waves.py` topologically groups them into dependency waves. The "hard rules" placeholders in `.claude/commands/automated/story-implement.md` are still generic templates — treat the conventions in this file as the real project rules.
