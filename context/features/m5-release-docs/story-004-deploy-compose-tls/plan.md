#plan

# Plan: Production deploy compose (pull image) + Caddy TLS

## Summary
Add a self-contained production deploy bundle under `deploy/` — a compose file that **pulls** the published GHCR server image (no `build:`), fronts it with a **Caddy** service for automatic Let's Encrypt TLS/WSS, mounts a persistent `/data` volume, and exposes the UDP RTC media range directly to the container — plus a `.env.example`, a `Caddyfile`, and the `contracts/deploy-compose.md` interface for story 005. The root dev compose is left intact except for one reconciliation: the UDP media range is unified to a single value (`40000-40010`) across the dev compose and `server/.env.example` so the compose port mapping and `RTC_MIN_PORT`/`RTC_MAX_PORT` agree everywhere (CLAUDE.md hard rule). No application/TypeScript changes — everything required already exists in the image and `loadConfig()`.

Decisions settled in this plan (delegated to story 004 by the AC / research Open Questions):
- **UDP range = `40000-40010`** (11 ports, ample for ≤10 clients, smaller forward surface). `server/.env.example`'s stale `RTC_MAX_PORT=40100` is corrected down to `40010` so all four places (prod compose ports, `deploy/.env.example`, dev compose ports, `server/.env.example`) agree. `config.ts`'s code default (`40100`) is intentionally left untouched — it is the fallback when env is unset, not a deploy value, and every deploy path sets the var explicitly.
- **Caddy as a compose service** is the primary documented TLS path (per `SPEC.md §12`), with a short "bring your own cert/proxy" note covering the existing Cloudflare-tunnel deployment.
- **Image pinned via `${SERVER_IMAGE_TAG:-latest}`** so the file is generic but an operator pins `:<version>` in `.env` for prod (story 002 contract guidance).

## Implementation Steps

### Step 1: Create the production compose file
**File(s):** `deploy/docker-compose.yml`
**Action:** create
**Description:** The new primary production artifact. Mirrors the service/env/volume/port shape of the root dev compose but (a) swaps `build: ./server` for the published GHCR `image:`, (b) adds a `caddy` service terminating HTTPS/WSS in front of the server, and (c) drops the dev-only `cloudflared` and `web`-from-`build` specifics (the prod web client is served by Caddy-fronted static hosting only if desired; primary scope is server + Caddy per the AC — see note below). A header comment states this is the **PRODUCTION** compose (pulls the image, TLS via Caddy) and that the root `docker-compose.yml` is the dev/contributor file (builds from source).
**Diff shape:**
- Add: `server` service with
  - `image: ghcr.io/tdmiller1/discord-clone-server:${SERVER_IMAGE_TAG:-latest}` (no `build:`).
  - `environment:` block driving `loadConfig()`: `NODE_ENV: production`, `HTTP_PORT: "8080"`, `DATA_DIR: /data`, `PUBLIC_HOST: ${PUBLIC_HOST:?set PUBLIC_HOST...}` (required, no localhost fallback — see Edge Cases), `RTC_EXTRA_ANNOUNCED_IPS: ${RTC_EXTRA_ANNOUNCED_IPS:-}`, `RTC_MIN_PORT: "40000"`, `RTC_MAX_PORT: "40010"`, `MAX_UPLOAD_MB: ${MAX_UPLOAD_MB:-10}`, `SESSION_TTL: ${SESSION_TTL:-604800}` (surfaced per AC; dev compose omits it), and optionally `AUTH_RATE_MAX`/`AUTH_RATE_WINDOW_MS` from env with defaults.
  - `ports:` only the UDP media range — `"40000-40010:40000-40010/udp"` with the "Keep in sync with RTC_*_PORT" comment. **HTTP `8080` is NOT published to the host** in prod; only Caddy is internet-facing, the server is reached over the internal compose network (`server:8080`). (Comment explains this differs from dev, which publishes `8080:8080` directly.)
  - `volumes: - discord-data:/data`, `restart: unless-stopped`.
  - `expose: - "8080"` (documents the internal-only HTTP port for Caddy).
- Add: `caddy` service —
  - `image: caddy:2` (pinned major), `restart: unless-stopped`.
  - `ports: - "80:80"` and `- "443:443"` (and `- "443:443/udp"` for HTTP/3, optional, commented).
  - `volumes:` mount `./Caddyfile:/etc/caddy/Caddyfile:ro`, named `caddy-data:/data` (ACME certs/account — survives restarts, avoids LE rate limits), named `caddy-config:/config`.
  - `environment:` `CADDY_SITE: ${CADDY_SITE:?...}` (the public domain) and `CADDY_ACME_EMAIL: ${CADDY_ACME_EMAIL:-}` consumed by the Caddyfile via env placeholders.
  - `depends_on: - server`.
- Add: `volumes:` block declaring `discord-data`, `caddy-data`, `caddy-config`.
- Change/Remove vs dev compose: no `build:`, no `image: discord-clone-server:dev`, no `cloudflared`, no host-published `8080`.

> Web client note: the AC scopes this story to "an HTTPS/WSS server with voice" (server + Caddy). The hosted web client (`web` service) is a separate concern already shipped in the dev compose and reachable via the existing tunnel; the prod compose focuses on server+TLS. The `contracts/deploy-compose.md` will note that operators wanting the hosted web client over Caddy can add a `web` service and a second Caddy site block, but it is optional and out of this story's required scope (consistent with story-005 owning the runbook).

### Step 2: Create the production env template
**File(s):** `deploy/.env.example`
**Action:** create
**Description:** Env template the prod compose reads (Compose auto-loads `.env` from the compose file's directory; `${VAR}` interpolation). Mirrors the comment style of the root `.env.example` and surfaces exactly the knobs an operator must/may set. Only var names present in `loadConfig()` (plus the Caddy site vars and the image tag selector) — no invented config.
**Diff shape:**
- Add (required, no safe default):
  - `SERVER_IMAGE_TAG=` — pin to a released `<version>` (e.g. `0.2.0`) per story 002; comment notes default is `latest` if unset and that pinning is recommended in prod.
  - `PUBLIC_HOST=` — the real routable public IPv4/hostname the SFU announces as the ICE address (`SPEC.md §11`). Comment: **never `localhost`**; UDP `RTC_MIN_PORT-RTC_MAX_PORT` must be port-forwarded directly to this host (NOT via Caddy/tunnel).
  - `CADDY_SITE=` — the public domain Caddy serves TLS for (e.g. `discord.example.com`). Must resolve (A/AAAA) to this host for Let's Encrypt HTTP-01/TLS-ALPN to succeed.
  - `CADDY_ACME_EMAIL=` — email for the ACME account / expiry notices (optional but recommended).
- Add (optional, defaults shown matching `loadConfig()`):
  - `RTC_EXTRA_ANNOUNCED_IPS=` (empty), `MAX_UPLOAD_MB=10`, `SESSION_TTL=604800`, `AUTH_RATE_MAX=10`, `AUTH_RATE_WINDOW_MS=60000`.
- Add comment block: the UDP range is fixed at `40000-40010` in the compose port mapping and must equal the server's `RTC_MIN_PORT`/`RTC_MAX_PORT` (which the compose sets to those same values) — do not change one without the other.
- Add comment: GHCR package may be private on first publish — `docker login ghcr.io -u tdmiller1` with a `read:packages` PAT, or make the package public (cross-ref story 002 contract; full runbook in story 005).

### Step 3: Create the Caddyfile
**File(s):** `deploy/Caddyfile`
**Action:** create
**Description:** Minimal Caddy site config that terminates HTTPS for the operator's domain and reverse-proxies everything to the server container. Caddy's `reverse_proxy` forwards WebSocket `Upgrade`/`Connection` automatically, so `/health`, `/`, `/api/*`, attachment streams, and the `/ws` gateway all traverse it with no manual header munging. Uses Caddy env placeholders so the domain/email come from compose env (no hard-coded domain).
**Diff shape:**
- Add: `{$CADDY_SITE} {` site block containing `reverse_proxy server:8080`.
- Add: optional global `email {$CADDY_ACME_EMAIL}` (or `tls {$CADDY_ACME_EMAIL}`) so ACME registers with the operator's email; guarded so an empty email still works (Caddy issues without an account email).
- Add: a prominent comment stating the **WebRTC media UDP range (`40000-40010/udp`) bypasses Caddy entirely** — it is raw DTLS-SRTP, not HTTP, and reaches the `server` container directly via the compose UDP port mapping + host firewall/router forward. Caddy only proxies HTTP/WS on 80/443.
- Add: a comment that `reverse_proxy` handles the WS upgrade for `/ws` automatically (no extra config), and that the single proxied origin (`https://{$CADDY_SITE}`) serves the whole API + `wss://{$CADDY_SITE}/ws`.

### Step 4: Reconcile the dev compose UDP range comment (no range change needed)
**File(s):** `docker-compose.yml` (root, dev)
**Action:** modify
**Description:** The dev compose already maps `40000-40010` and sets `RTC_MIN_PORT=40000`/`RTC_MAX_PORT=40010`, which are internally consistent. The only drift is against `server/.env.example` (fixed in Step 5). To make the cross-file invariant explicit, tighten the existing port comment to name both the env example and the chosen single range.
**Diff shape:**
- Change: the `# UDP media range ... Keep in sync with RTC_*_PORT.` comment → note the canonical range is `40000-40010` and must equal `RTC_MIN_PORT`/`RTC_MAX_PORT` here, in `server/.env.example`, and in `deploy/`. (No numeric change to this file — it is already on the chosen range.)

### Step 5: Reconcile `RTC_MAX_PORT` in the per-server env example
**File(s):** `server/.env.example`
**Action:** modify
**Description:** Resolve the documented drift: this file says `RTC_MAX_PORT=40100` (101 ports) while every compose maps `40000-40010`. Lower it to `40010` so the env example agrees with the dev and prod compose port mappings — the single consistent range the AC requires.
**Diff shape:**
- Change: `RTC_MAX_PORT=40100` → `RTC_MAX_PORT=40010`.
- Add: a one-line comment noting this must match the compose UDP port mapping (`40000-40010`).
- (No change to `config.ts` — its `40100` is the unset-env code fallback, not a deploy value; all deploy paths set the var explicitly. Documented in Summary.)

### Step 6: Create the deploy interface contract for story 005
**File(s):** `context/features/m5-release-docs/story-004-deploy-compose-tls/contracts/deploy-compose.md`
**Action:** create (the `contracts/` subdir does not exist yet — create it)
**Description:** The authoritative production-deploy interface story 005's runbook consumes. Records the canonical compose + Caddyfile shape, the operator-set env vars (with defaults), the ports/volumes (HTTP/HTTPS + UDP RTC range), how the GHCR image tag is selected, how TLS is obtained, and the one-command bring-up sequence. Cross-references the story 002 image contract (image name/tags/visibility) and the story 001 versioning contract (`<version>` derivation) rather than re-deriving them.
**Diff shape:**
- Add: `#contract` header + title; "consumed by story 005" framing.
- Add: **Location & services** — `deploy/docker-compose.yml`, `deploy/.env.example`, `deploy/Caddyfile`; services `server` (pulled image, internal `:8080`) + `caddy` (80/443, TLS).
- Add: **Image selection** — `ghcr.io/tdmiller1/discord-clone-server:${SERVER_IMAGE_TAG:-latest}`; pin `:<version>` (= `${GITHUB_REF_NAME#v}` == root `package.json .version`) in `.env` for prod; private-package login note.
- Add: **Required env vars** table — `PUBLIC_HOST` (real routable host, never localhost; the ICE announce address), `CADDY_SITE` (DNS must point here), `SERVER_IMAGE_TAG`, `CADDY_ACME_EMAIL`; **optional** `RTC_EXTRA_ANNOUNCED_IPS`, `MAX_UPLOAD_MB=10`, `SESSION_TTL=604800`, `AUTH_RATE_MAX=10`, `AUTH_RATE_WINDOW_MS=60000`; fixed `RTC_MIN_PORT=40000`/`RTC_MAX_PORT=40010`.
- Add: **Ports & volumes** — Caddy `80/tcp` + `443/tcp` (+ optional `443/udp` HTTP/3); server UDP `40000-40010/udp` direct to container (must also be router/firewall-forwarded to `PUBLIC_HOST`); server HTTP `8080` internal-only (not host-published). Volumes: `discord-data:/data` (SQLite + images — persistent), `caddy-data:/data` + `caddy-config:/config` (ACME certs — persistent).
- Add: **TLS / WSS / media topology** — Caddy terminates HTTPS and reverse-proxies `https://{CADDY_SITE}` + `wss://{CADDY_SITE}/ws` to `server:8080` (WS upgrade auto-forwarded); media UDP bypasses Caddy entirely (DTLS-SRTP straight to `PUBLIC_HOST:40000-40010`).
- Add: **One-command bring-up** — `cd deploy && cp .env.example .env && $EDITOR .env && docker compose up -d`; then verify `curl -sf https://{CADDY_SITE}/health` and a `wss://{CADDY_SITE}/ws` connect.
- Add: **Bring-your-own-proxy note** — Caddy is the primary path; the existing Cloudflare-tunnel deploy (root compose `cloudflared`) or any external TLS proxy is acceptable as long as it forwards the WS upgrade and the UDP media range reaches the container directly.

## New Types / Schemas / Contracts

No code types/schemas. New file shapes introduced (authoritative for story 005):

- **`deploy/docker-compose.yml`** — production compose; services `server` (image-pulled, internal HTTP, UDP media published) and `caddy` (TLS front, 80/443); named volumes `discord-data`, `caddy-data`, `caddy-config`.
- **`deploy/.env.example`** — operator env template; keys: `SERVER_IMAGE_TAG`, `PUBLIC_HOST`, `CADDY_SITE`, `CADDY_ACME_EMAIL`, `RTC_EXTRA_ANNOUNCED_IPS`, `MAX_UPLOAD_MB`, `SESSION_TTL`, `AUTH_RATE_MAX`, `AUTH_RATE_WINDOW_MS`.
- **`deploy/Caddyfile`** — single site `{$CADDY_SITE} { reverse_proxy server:8080 }` with ACME email placeholder.
- **`contracts/deploy-compose.md`** — the deploy interface contract (see Step 6).

## Configuration / Environment Changes

| Name | Where set | Default | Notes |
| ---- | --------- | ------- | ----- |
| `SERVER_IMAGE_TAG` | `deploy/.env` → compose `image:` | `latest` (via `:-`) | Pin to released `<version>` (e.g. `0.2.0`) in prod (story 002). |
| `PUBLIC_HOST` | `deploy/.env` → server env | **required** (`:?`) | Real routable host; ICE announce address (`§11`). Never `localhost` in prod. |
| `CADDY_SITE` | `deploy/.env` → caddy env → Caddyfile | **required** (`:?`) | Public domain; DNS A/AAAA must point to this host for Let's Encrypt. |
| `CADDY_ACME_EMAIL` | `deploy/.env` → caddy env → Caddyfile | empty | ACME account / expiry email. |
| `RTC_EXTRA_ANNOUNCED_IPS` | `deploy/.env` → server env | empty | Extra ICE IPs (e.g. LAN IP). Each consumes a UDP port per transport. |
| `MAX_UPLOAD_MB` | `deploy/.env` → server env | `10` | Matches `loadConfig()`. |
| `SESSION_TTL` | `deploy/.env` → server env | `604800` | Surfaced per AC (dev compose omits it). |
| `AUTH_RATE_MAX` | `deploy/.env` → server env | `10` | Optional. |
| `AUTH_RATE_WINDOW_MS` | `deploy/.env` → server env | `60000` | Optional. |
| `RTC_MIN_PORT` / `RTC_MAX_PORT` | prod compose `environment:` (literals) | `40000` / `40010` | **Must equal** the compose UDP port mapping. |

**Ports (prod):**
- Caddy `80:80/tcp`, `443:443/tcp` (+ optional `443:443/udp` HTTP/3) — internet-facing TLS.
- Server `40000-40010:40000-40010/udp` — SFU media, direct to container; **also** needs a host firewall allow + router UDP forward to `PUBLIC_HOST`.
- Server HTTP `8080` — `expose`d internal-only; **not** host-published in prod (Caddy reaches it via `server:8080` on the compose network).

**Volumes (prod):** `discord-data → /data` (server: SQLite + images, persistent), `caddy-data → /data` + `caddy-config → /config` (Caddy: ACME certs/account, persistent so certs survive `down/up` and avoid LE rate limits).

**UDP range reconciliation (project hard rule):** single canonical range `40000-40010` across all four places — prod compose port mapping + prod `RTC_MIN_PORT`/`RTC_MAX_PORT`, `deploy/.env.example` comment, root dev compose port mapping + env (already on it), and `server/.env.example` (Step 5 lowers `40100`→`40010`). Each place carries a comment tying the compose mapping ⇄ `RTC_*_PORT`. The `config.ts` code default (`40100`) is the unset-env fallback and is intentionally left unchanged.

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| Caddy reverse proxy | `https://{CADDY_SITE}/*` | client HTTPS to `/health`, `/`, `/api/*`, attachments | proxied to `server:8080` over compose net | TLS terminated at Caddy; server sees plain HTTP. |
| Caddy reverse proxy | `wss://{CADDY_SITE}/ws` | WS upgrade (gateway + voice signaling) | upgraded + forwarded to `server:8080/ws` | `reverse_proxy` auto-forwards `Upgrade`/`Connection`. |
| SFU media (not proxied) | `PUBLIC_HOST:40000-40010/udp` | DTLS-SRTP Opus media | direct to `server` container | Bypasses Caddy; needs router/firewall UDP forward. |
| Compose CLI | `docker compose up -d` (in `deploy/`) | `deploy/.env` | running `server` + `caddy` | One-command bring-up. |

No HTTP/WS application-route changes — the server's surface (`server/src/app.ts`) is unchanged; this story only changes how it is deployed and fronted.

## Edge Cases & Gotchas

- **WSS upgrade through the proxy** (feature edge case) — Caddy `reverse_proxy` forwards the WS `Upgrade`/`Connection` headers automatically, so `/ws` (gateway + voice signaling) works over WSS with no special config. The Caddyfile comment calls this out so no one "fixes" it by adding broken manual header rules → Step 3.
- **`PUBLIC_HOST=localhost` silently kills remote voice** — the SFU announces it as the ICE candidate, so remote clients try to reach `localhost` for media and get no audio while text/`/health` look fine. The prod compose marks `PUBLIC_HOST` **required** via `${PUBLIC_HOST:?...}` so `up` fails fast with a clear message instead of booting with a broken voice path → Step 1.
- **Media UDP must bypass Caddy and reach the container directly** — it is raw DTLS-SRTP, not HTTP; Caddy only handles 80/443 TCP. Requires the compose UDP mapping AND a host firewall allow + router UDP forward to `PUBLIC_HOST`. Documented in Caddyfile + contract → Steps 3, 6.
- **UDP range drift / CLAUDE.md hard rule** — compose port mapping must equal `RTC_MIN_PORT`/`RTC_MAX_PORT`; reconciled to `40000-40010` everywhere and `server/.env.example`'s stale `40100` corrected → Steps 1, 4, 5.
- **Two compose files must not confuse the admin** (feature edge case) — prod lives under `deploy/` and is header-commented PRODUCTION (pulls image); root stays dev (builds from source). Distinct directories + labels → Steps 1, 4.
- **GHCR package private on first publish** — anonymous `pull` fails until the package is made public or the host runs `docker login ghcr.io -u tdmiller1` with a `read:packages` PAT. Surfaced in `deploy/.env.example` + contract (full steps in story 002 contract / story 005 runbook) → Steps 2, 6.
- **Let's Encrypt rate limits / cert loss on restart** — Caddy's `/data` (ACME account + certs) is a named volume so certs survive `down/up`; otherwise repeated restarts could exhaust LE issuance limits → Step 1.
- **DNS prerequisite for TLS** — `CADDY_SITE` must resolve to the host before `up`, or ACME issuance fails (and Caddy will retry). Noted in `.env.example` + contract → Steps 2, 6.
- **Server HTTP port not host-published in prod** — only Caddy is internet-facing; the server is reached at `server:8080` on the compose network. Comment explains the difference from dev (which publishes `8080:8080`) → Step 1.
- **Real cert is environment-dependent** — per the AC, end-to-end TLS with a public domain is documented, not CI-tested; local verification is "stack comes up, `/health` over the proxy, WS gateway accepts a connection" (a self-signed/`internal` Caddy or `--resolver` against a test domain stands in) → Step 6 / verification note.

## Acceptance Criteria Checklist

- [ ] Production compose artifact (`deploy/docker-compose.yml` + `deploy/.env.example`) that **pulls** `ghcr.io/tdmiller1/discord-clone-server:${SERVER_IMAGE_TAG:-latest}` instead of `build: ./server`, leaving the root dev compose for contributors → Steps 1, 2, 4
- [ ] Sets production env from `loadConfig()`/`§12`: required real `PUBLIC_HOST`, `DATA_DIR=/data` on a named volume, `MAX_UPLOAD_MB`, `SESSION_TTL`, `RTC_MIN_PORT`/`RTC_MAX_PORT`; values from the env file, not hard-coded → Steps 1, 2
- [ ] UDP media range exposed and the compose port mapping matches `RTC_MIN_PORT`–`RTC_MAX_PORT`; dev drift (`40000-40010` vs `.env.example 40000-40100`) resolved to a single consistent range with a tying comment → Steps 1, 4, 5
- [ ] TLS via Caddy: a `caddy` service + `Caddyfile` terminates HTTPS and reverse-proxies to the server, passing the WS upgrade through for the gateway/voice signaling; Caddyfile notes the media UDP range bypasses Caddy and must reach the container directly → Steps 1, 3
- [ ] Internally consistent, labeled PRODUCTION (distinct from dev), `/data` a persistent named volume so SQLite + images survive restarts → Steps 1, 4
- [ ] Verified to start: stack up serves `/health` over the proxy and the WS gateway accepts a connection (real public cert documented, not CI-tested) → Step 6 (verification note) / implement+validate phases
- [ ] `contracts/deploy-compose.md` records prod compose + Caddyfile shape, operator env vars (esp. `PUBLIC_HOST` + UDP range), and TLS/WSS/media-port topology for story 005 → Step 6
