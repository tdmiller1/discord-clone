#research

# Research: Production deploy compose (pull image) + Caddy TLS

## Files to Touch

### Likely Created
- `deploy/docker-compose.yml` — the **production** compose. Distinct from the root dev compose: `image: ghcr.io/tdmiller1/discord-clone-server:<version|latest>` (story 002 contract) instead of `build: ./server`; adds a `caddy` service for TLS/WSS termination; named `/data` volume; UDP media range exposed. This is the new primary artifact.
- `deploy/.env.example` — prod env template consumed by the prod compose (`env_file`/`${VAR}`). Must surface the admin-set knobs: real `PUBLIC_HOST`, `SERVER_IMAGE_TAG` (or pinned `:<version>`), `RTC_MIN_PORT`/`RTC_MAX_PORT`, `MAX_UPLOAD_MB`, `SESSION_TTL`, `AUTH_RATE_*`, plus the Caddy site domain + ACME email. Mirrors the shape/comment style of the root `.env.example` and `server/.env.example`.
- `deploy/Caddyfile` — Caddy site config: `<domain> { reverse_proxy server:8080 }`. Caddy auto-provisions Let's Encrypt and `reverse_proxy` forwards the WS `Upgrade`/`Connection` headers transparently (no manual header munging needed). Comment must note the media UDP range bypasses Caddy and reaches the `server` container directly.
- `context/features/m5-release-docs/story-004-deploy-compose-tls/contracts/deploy-compose.md` — the deliverable contract for story 005 (canonical prod compose + Caddyfile shape, required env vars, TLS/WSS/media-port topology). The `contracts/` subdir does not exist yet under story-004 — create it.

### Likely Modified
- `docker-compose.yml` (root, dev) — resolve the documented drift the story calls out: compose maps UDP `40000-40010` while `server/.env.example` says `40000-40100`. Pick one consistent range and add a comment tying the compose port mapping to `RTC_MIN_PORT`/`RTC_MAX_PORT`. (Touch is bounded to the range/comment reconciliation; do not restructure the dev file.)
- `server/.env.example` — reconcile `RTC_MAX_PORT` to whatever single range is chosen (currently `40100` vs compose `40010`), so dev compose and the env example agree.

### Read-Only Reference (patterns to follow)
- `docker-compose.yml` (root) — service/env/volume/port shape to mirror for the prod file: `environment:` block driving `loadConfig()`, `volumes: discord-data:/data`, `ports: "8080:8080"` + `"40000-40010:40000-40010/udp"`, `restart: unless-stopped`. The prod file is a re-shaping of this, swapping `build:` for `image:` and adding Caddy.
- `.env.example` (root) — comment style and the deploy-var documentation pattern (`PUBLIC_HOST`, `VITE_SERVER_URL`, tunnel token) to mirror in `deploy/.env.example`.
- `server/.env.example` — canonical per-server runtime var list (`SPEC.md §12`): `NODE_ENV`, `HTTP_PORT`, `DATA_DIR`, `PUBLIC_HOST`, `RTC_MIN_PORT`, `RTC_MAX_PORT`, `MAX_UPLOAD_MB`, `SESSION_TTL`, `AUTH_RATE_MAX`, `AUTH_RATE_WINDOW_MS`, `MAX_MESSAGE_LENGTH`, `MSG_HISTORY_*`.
- `server/src/config.ts` — `loadConfig()` is the authority on which env vars exist and their defaults/types. Do not invent config; only set names present here.
- `server/Dockerfile` — confirms the published image contract: `EXPOSE 8080`, `VOLUME /data`, `HEALTHCHECK` hitting `/health`, runs as `node` user, defaults `NODE_ENV=production HTTP_PORT=8080 DATA_DIR=/data`. The prod compose inherits these; only overrides (esp. `PUBLIC_HOST`) and the volume mount + UDP range need to be set.
- `client/src/lib/gateway.svelte.ts` — `WS_PATH = "/ws"` and `wsUrl()` flips `https:`→`wss:`. Confirms the proxy must pass WS upgrade on the **same host** at `/ws` (Caddy `reverse_proxy` does this automatically). Client derives the WS URL from the `serverUrl` base, so a single proxied origin (`https://<domain>`) serves `/health`, `/api/*`, attachments, and `/ws`.
- `server/src/app.ts` — route surface that must traverse the proxy: `/health`, `/` (info), `/api/*` (auth/channels/attachments), and the `/ws` gateway (registered via `wsGateway`). All HTTP/WS; all proxied through Caddy. Voice **media** is not an HTTP route — it is raw UDP, never through Caddy.
- `server/src/voice/sfu.ts` — uses `rtcAnnouncedIps` (public + extra) as ICE candidates; reinforces why `PUBLIC_HOST` must be the real routable host, never `localhost`, and why the UDP range must reach the container directly.

## Existing Patterns

**Current (dev) compose — `docker-compose.yml`** has three services: `server` (`build: ./server`, `image: discord-clone-server:dev`), `web` (nginx Vite build), `cloudflared` (host networking, Cloudflare Tunnel). Key facts the prod file builds on:
- `server` env block sets `NODE_ENV`, `HTTP_PORT=8080`, `DATA_DIR=/data`, `PUBLIC_HOST: ${PUBLIC_HOST:-localhost}`, `RTC_EXTRA_ANNOUNCED_IPS`, `RTC_MIN_PORT=40000`, `RTC_MAX_PORT=40010`, `MAX_UPLOAD_MB=10`. Note dev compose omits `SESSION_TTL`/`AUTH_RATE_*` (defaults apply) — the prod file/contract should surface `SESSION_TTL` per the AC.
- Ports: `"8080:8080"` (HTTP) + `"40000-40010:40000-40010/udp"` (SFU media). Comment already says "Keep in sync with RTC_*_PORT" (the CLAUDE.md gotcha).
- Volume: named `discord-data` → `/data`; `restart: unless-stopped`.

**The drift the AC names:** dev compose UDP `40000-40010` (11 ports) vs `server/.env.example` `RTC_MIN_PORT=40000 RTC_MAX_PORT=40100` (101 ports). `config.ts` default is `40100`. Must be reconciled to a single range across compose port mapping + env example, with a comment tying them. (A small range like `40000-40010` is fine for ≤10 clients; whatever is chosen, the three places — prod compose ports, prod `.env.example`, and the dev compose/`server/.env.example` — must agree.)

**Image name (story 002 contract, fixed):** `ghcr.io/tdmiller1/discord-clone-server`, tags `:<version>` (pin in prod) and `:latest`. `<version> = ${GITHUB_REF_NAME#v}` == root `package.json` `.version` (currently `0.2.0`). Package may be **private** on first publish → prod host may need `docker login ghcr.io -u tdmiller1` with a `read:packages` PAT, or the package is made public. The prod compose references the image by name; the auth/visibility note is the contract's, surfaced for story 005's runbook.

**Existing public-deploy topology (commit `ba66367`, also in MEMORY `deployment-topology.md`):** today's public path uses **Cloudflare Tunnel** (`cloudflared`, host networking) — `discord.<zone>` → `http://localhost:8080`, `app.<zone>` → `http://localhost:8083`. Voice UDP does **not** traverse the tunnel and needs a direct router UDP port-forward. This story does **not** rip that out — it introduces the **Caddy** TLS path as the SPEC-recommended (`§12`) reverse proxy for a self-hoster who exposes the host directly (own domain + Let's Encrypt) rather than via Cloudflare. Both terminate TLS in front and pass WSS through; the media-UDP-bypasses-the-proxy invariant is identical. The contract/docs should note Caddy is the primary documented path and "bring your own cert/proxy" (incl. the existing tunnel) is acceptable.

**Caddy WS passthrough:** Caddy's `reverse_proxy` forwards WebSocket upgrades automatically — no explicit `Upgrade`/`Connection` header handling is required (unlike hand-rolled nginx). A minimal `<domain> { reverse_proxy server:8080 }` is sufficient for `/health`, `/api/*`, attachments, and `/ws`. Caddy needs ports `80`+`443` published and a persistent volume for `/data` (certs) and `/config` so certs survive restarts.

## Data Flow

**Client HTTP/WS path (TLS-terminated):**
1. Client points at `https://<domain>` (the `serverUrl` base). REST calls (`/api/register`, `/api/login`, `/api/channels/...`, `/api/attachments`) go to `https://<domain>/...`.
2. The gateway WS: `wsUrl()` flips `https:`→`wss:` and uses path `/ws` on the same host → `wss://<domain>/ws`.
3. Caddy (ports 443/80) terminates TLS, auto-provisions a Let's Encrypt cert for `<domain>`, and `reverse_proxy server:8080` forwards **both** plain HTTP and the WebSocket upgrade over the compose-internal network to the `server` container's `8080`. Server sees plain HTTP/WS internally; the client sees HTTPS/WSS. Attachment downloads (`GET /api/attachments/:id`) stream back through the same proxy.

**Voice / UDP media path (bypasses TLS proxy entirely):**
1. Voice **signaling** (`voice.join`, `voice.signal` SDP/ICE) rides the existing `/ws` socket → through Caddy like any WS frame.
2. Voice **media** (Opus, DTLS-SRTP) is raw UDP on `RTC_MIN_PORT`–`RTC_MAX_PORT`. The SFU advertises `PUBLIC_HOST` (+ `RTC_EXTRA_ANNOUNCED_IPS`) as ICE candidates (`sfu.ts` / `config.ts.rtcAnnouncedIps`). Clients send media **directly to `PUBLIC_HOST:<udp-port>`**, which must be host-firewall-open and compose-mapped (`"40000-40010:40000-40010/udp"`) straight to the `server` container. Caddy never touches this — it is not HTTP. `PUBLIC_HOST=localhost` ⇒ ICE announces localhost ⇒ remote voice silently fails.

**Where TLS terminates:** at Caddy. Server↔Caddy is plain HTTP on the internal compose network; Caddy↔client is HTTPS/WSS. WebRTC media is independently encrypted (DTLS-SRTP) and does not depend on the Caddy TLS at all.

## Decisions Made

1. **New `deploy/` directory, root dev compose kept.** The AC explicitly wants two clearly-labeled files (`deploy/docker-compose.yml` for prod, root `docker-compose.yml` left for contributors). Putting prod artifacts under `deploy/` (compose + `.env.example` + `Caddyfile`) keeps the dev experience untouched and matches the feature edge case "two compose files must not confuse the admin."
2. **Caddy as a compose service (not external proxy) is the primary path.** `SPEC.md §12` recommends Caddy for automatic Let's Encrypt; making it a service gives "one `docker compose up -d` ⇒ working HTTPS/WSS." A short "bring your own cert/proxy" note covers the existing Cloudflare-tunnel deployment and other proxies (story explicitly allows this), but Caddy is documented as primary.
3. **Image referenced as `ghcr.io/tdmiller1/discord-clone-server:${SERVER_IMAGE_TAG:-latest}` (pin `:<version>` in `.env`).** Honors story 002's contract verbatim and the contract's advice to pin `:<version>` in prod while keeping the file generic via an env var defaulting to `latest`.
4. **Reconcile the UDP range to a single value across all four places.** Prod compose ports, `deploy/.env.example`, root dev compose ports, and `server/.env.example` must all agree on one `RTC_MIN_PORT`–`RTC_MAX_PORT` (with a comment tying compose mapping ⇄ env). Keep the existing `40000-40010` (sufficient for ≤10 clients) and fix `server/.env.example`'s `40100` to match, or widen compose to `40100` — either is acceptable as long as all four agree; the plan picks one. Default lean: keep `40000-40010` (smaller forward surface) and correct the env example.
5. **No app/TypeScript changes.** Everything needed (`/data` volume, `EXPOSE 8080`, `HEALTHCHECK`, env-driven config) already exists in the image and `config.ts`. This story is compose + Caddyfile + env templates + the contract only. Verification is "stack comes up, `/health` over the proxy, WS gateway accepts a connection" (real cert is environment-dependent, documented not CI-tested).
6. **Caddy gets its own named volumes** for `/data` (ACME certs/account) and `/config` so issued certs survive `docker compose down/up` and avoid Let's Encrypt rate limits.

## Open Questions

None — the upstream image contract fixes the image name/tags, `loadConfig()`/`SPEC.md §12` fix the env surface, the existing dev compose fixes the service/volume/port shape, and `SPEC.md §12` fixes Caddy as the TLS path. The only open choice (exact UDP range value) is a reconciliation the AC delegates to this story and the plan can settle deterministically.
