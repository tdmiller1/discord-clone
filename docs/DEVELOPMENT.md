# Development

Monorepo layout:

```
server/   Node + TypeScript backend (Fastify HTTP/WS, SQLite, SFU).  Shipped as a Docker image.
client/   Tauri desktop app: Svelte + TS frontend (src/) + Rust shell (src-tauri/).
scripts/  engineering-manager pipeline helpers.
SPEC.md   What we're building and the milestone roadmap (M0–M5).
```

This doc covers building and running from source. To **deploy the published image**, see the
deploy runbook in the [root `README.md`](../README.md) and the operations reference in
[`docs/DEPLOYMENT.md`](DEPLOYMENT.md).

## Prerequisites

- **Node** ≥ 20 (24 recommended) — server and client frontend.
- **Docker** + Compose — to run the server.
- **Rust** (stable) + Tauri system deps — only to build the desktop client.
  - Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev patchelf build-essential file libssl-dev libxdo-dev libdbus-1-dev`
  - See https://tauri.app/start/prerequisites/ for Windows/macOS.

## Server

```bash
cd server
npm install
npm run dev        # tsx watch, reloads on change
npm run build      # tsc -> dist/
npm start          # node dist/index.js
npm run typecheck  # tsc --noEmit
curl http://localhost:8080/health
```

Run it in Docker (from the repo root):

```bash
docker compose up -d --build   # or: npm run docker:up
curl http://localhost:8080/health
docker compose down            # or: npm run docker:down
```

Config is env-driven — see `server/.env.example` and SPEC.md §12.

## Client

```bash
cd client
npm install
npm run dev        # Vite dev server on :1420 (frontend only, in a browser)
npm run check      # svelte-check type-check
npm run build      # Vite production build -> dist/
```

Desktop app (needs Rust + system deps):

```bash
npm run icons      # one-time: generate src-tauri/icons/* from src-tauri/app-icon.png
npm run tauri dev  # launches the native window with the webview
npm run tauri build  # produces installers under src-tauri/target/release/bundle/
```

> `src-tauri/icons/` is generated (gitignored). `npm run icons` must run once before
> `tauri dev`/`tauri build`; CI does this automatically.

## CI

`.github/workflows/ci.yml`:
- **server** — build, `/health` smoke test, Docker image build.
- **client** — `tauri build` on `ubuntu-latest` + `windows-latest` builds the
  AppImage/deb/msi/exe installers as the per-change gate.

On a `v*` tag push the release jobs additionally publish the server image to GHCR and attach the
four client installers to a **GitHub Release** (the distributable surface — see the deploy
runbook in the [root `README.md`](../README.md)).
