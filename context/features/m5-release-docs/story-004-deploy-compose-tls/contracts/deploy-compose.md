#contract

# Contract: Production deploy compose + Caddy TLS (M5 story 004)

Authoritative description of the production deployment interface. **Story 005
(deployment/release runbook) implements its walkthrough against exactly this** —
the file locations, services, operator-set env vars, ports/volumes, image-tag
selection, TLS topology, and one-command bring-up below are the single source of
truth for "how an admin stands up the server."

Cross-references (do not re-derive):

- Image name/tags/visibility: `../../story-002-release-server-image/contracts/server-image.md`
  (`ghcr.io/tdmiller1/discord-clone-server:<version>` / `:latest`, amd64/glibc only,
  GHCR-private-on-first-publish caveat).
- `<version>` derivation: `../../story-001-release-versioning/contracts/versioning.md`
  (`<version> = ${GITHUB_REF_NAME#v}` == root `package.json .version`).

---

## Location & services

The production bundle lives under `deploy/` (distinct from the root
`docker-compose.yml`, which is the dev/contributor file that builds from source):

```
deploy/docker-compose.yml   # prod compose — PULLS the image, no build:
deploy/.env.example         # operator env template — copy to deploy/.env
deploy/Caddyfile            # Caddy site config (TLS + reverse proxy)
```

Two services:

| Service  | Image                                            | Role                                                              |
| -------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `server` | `ghcr.io/tdmiller1/discord-clone-server:<tag>`   | App server. HTTP `8080` internal-only; publishes UDP media range. |
| `caddy`  | `caddy:2`                                         | Internet-facing TLS front (80/443); reverse-proxies to `server`.  |

There is **no `build:` in the prod compose** — `server` is pulled from GHCR
(story 002 contract). The dev-only `web` and `cloudflared` services are not part
of the prod bundle (see "Bring your own proxy" for the existing tunnel path).

## Image selection

```yaml
image: ghcr.io/tdmiller1/discord-clone-server:${SERVER_IMAGE_TAG:-latest}
```

- `SERVER_IMAGE_TAG` is set in `deploy/.env`. **Pin a released `<version>`**
  (e.g. `0.2.0`) in prod; it defaults to `latest` if unset.
- `<version> = ${GITHUB_REF_NAME#v}` == root `package.json .version` (versioning
  contract). The image is **amd64/glibc only** (server-image contract).
- **GHCR may be private on first publish.** Anonymous `docker pull` fails until
  the package is made public, or the host authenticates:
  ```sh
  echo "<PAT-with-read:packages>" | docker login ghcr.io -u tdmiller1 --password-stdin
  ```
  (Both paths are detailed in the story 002 image contract.)

## Required env vars (operator MUST set)

Set in `deploy/.env` (copied from `deploy/.env.example`). Required vars use
Compose's `${VAR:?...}` so `docker compose up` **fails fast** if unset.

| Var                | Required? | Default        | Notes                                                                                 |
| ------------------ | --------- | -------------- | ------------------------------------------------------------------------------------- |
| `PUBLIC_HOST`      | **yes**   | — (`:?` fails) | Real routable IPv4/hostname; the WebRTC ICE announce address (SPEC.md §11). **Never `localhost`** — remote voice silently fails. |
| `CADDY_SITE`       | **yes**   | — (`:?` fails) | Public domain Caddy serves TLS for (e.g. `discord.example.com`). DNS A/AAAA must resolve to this host before bring-up. |
| `SERVER_IMAGE_TAG` | no        | `latest`       | Pin to a released `<version>` (e.g. `0.2.0`) in prod.                                  |
| `CADDY_ACME_EMAIL` | no        | empty          | ACME account / cert-expiry email. Caddy issues without it.                             |

Optional server tuning (defaults match `loadConfig()` / SPEC.md §12):

| Var                       | Default  | Notes                                                              |
| ------------------------- | -------- | ----------------------------------------------------------------- |
| `RTC_EXTRA_ANNOUNCED_IPS` | empty    | Extra ICE IPs (e.g. LAN IP). Each consumes one more UDP port/transport. |
| `MAX_UPLOAD_MB`           | `10`     | Max image upload size.                                             |
| `SESSION_TTL`             | `604800` | Session lifetime (seconds) — surfaced per the AC.                  |
| `AUTH_RATE_MAX`           | `10`     | Auth-endpoint rate-limit max per IP.                              |
| `AUTH_RATE_WINDOW_MS`     | `60000`  | Auth rate-limit window.                                           |

Fixed in the compose (not env-tunable — literals in `server.environment`, equal
to the UDP port mapping):

| Var            | Value   |
| -------------- | ------- |
| `RTC_MIN_PORT` | `40000` |
| `RTC_MAX_PORT` | `40010` |
| `DATA_DIR`     | `/data` |
| `NODE_ENV`     | `production` |
| `HTTP_PORT`    | `8080`  |

## Ports & volumes

**Ports:**

| Service  | Mapping                          | Purpose                                                                 |
| -------- | -------------------------------- | --------------------------------------------------------------------- |
| `caddy`  | `80:80/tcp`, `443:443/tcp`       | Internet-facing TLS (HTTP-01/redirect on 80, HTTPS/WSS on 443).        |
| `caddy`  | `443:443/udp` (optional)         | HTTP/3 (QUIC) — commented out by default.                              |
| `server` | `40000-40010:40000-40010/udp`    | SFU media (DTLS-SRTP), **direct to container** — bypasses Caddy.       |
| `server` | `8080` (`expose`, internal-only) | HTTP/WS — **not host-published**; Caddy reaches it at `server:8080`.   |

- The UDP `40000-40010` range **MUST equal** `RTC_MIN_PORT`/`RTC_MAX_PORT`
  (CLAUDE.md hard rule). It must **also** be allowed by the host firewall and
  UDP-forwarded on the router to `PUBLIC_HOST` — Caddy/tunnel never carry it.

**Volumes (all named, persistent):**

| Volume          | Mount     | Holds                                                        |
| --------------- | --------- | ----------------------------------------------------------- |
| `discord-data`  | server `/data` | SQLite DB + uploaded images — survives restarts.       |
| `caddy-data`    | caddy `/data`  | ACME account + issued certs — survives `down/up`, avoids LE rate limits. |
| `caddy-config`  | caddy `/config`| Caddy autosave config.                                  |

`deploy/Caddyfile` is bind-mounted read-only at `/etc/caddy/Caddyfile`.

## TLS / WSS / media topology

- **TLS terminates at Caddy.** Caddy auto-provisions a Let's Encrypt cert for
  `{$CADDY_SITE}` and reverse-proxies to `server:8080` over the internal compose
  network. The server speaks plain HTTP/WS internally; clients see HTTPS/WSS.
- **One proxied origin** serves everything:
  - `https://{$CADDY_SITE}` → `/`, `/health`, `/api/*`, attachment streams.
  - `wss://{$CADDY_SITE}/ws` → the gateway + voice signaling. Caddy's
    `reverse_proxy` forwards the WebSocket `Upgrade`/`Connection` headers
    automatically — no manual header config.
- **Media UDP bypasses Caddy entirely.** Voice media (Opus, DTLS-SRTP) is raw
  UDP on `40000-40010`. The SFU advertises `PUBLIC_HOST` (+ any
  `RTC_EXTRA_ANNOUNCED_IPS`) as ICE candidates; clients send media directly to
  `PUBLIC_HOST:40000-40010/udp`. This depends only on the compose UDP mapping +
  host firewall/router forward, never on Caddy.

The minimal `Caddyfile` shape:

```caddyfile
{
	email {$CADDY_ACME_EMAIL}
}

{$CADDY_SITE} {
	reverse_proxy server:8080
}
```

## One-command bring-up

```sh
cd deploy
cp .env.example .env
$EDITOR .env            # set PUBLIC_HOST, CADDY_SITE (+ SERVER_IMAGE_TAG, CADDY_ACME_EMAIL)
# if the GHCR package is private: docker login ghcr.io -u tdmiller1
docker compose up -d
```

Prerequisites before `up`: `CADDY_SITE` DNS resolves to this host (for ACME),
and the UDP `40000-40010` range is firewall-allowed + router-forwarded to
`PUBLIC_HOST`.

Verify:

```sh
curl -sf https://{CADDY_SITE}/health          # 200 over the proxy (real cert)
# then connect a client to wss://{CADDY_SITE}/ws — the gateway accepts it
```

(A real public cert is environment-dependent and documented rather than
CI-tested; locally, Caddy's internal/self-signed CA or a test resolver stands in
for the "stack comes up, /health over the proxy, WS accepts" check.)

## Bring your own proxy (escape hatch)

Caddy is the **primary** documented TLS path (SPEC.md §12). Any external TLS
reverse proxy is acceptable instead — including the existing **Cloudflare tunnel**
deployment (root compose `cloudflared`) — as long as it:

1. terminates TLS and forwards the WebSocket `Upgrade` on the same origin so
   `wss://<host>/ws` reaches `server:8080`, and
2. lets the UDP media range (`40000-40010`) reach the `server` container
   directly (the tunnel does NOT carry it — a direct router UDP forward to
   `PUBLIC_HOST` is still required).

An operator who wants the hosted **web client** fronted by Caddy can add a `web`
service (see root compose) and a second Caddy site block; that is optional and
outside this story's required scope (story 005 owns any such runbook detail).
