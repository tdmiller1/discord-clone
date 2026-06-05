# Deployment

Operations reference for a **deployed** discord-clone server. For the step-by-step bring-up,
see the deploy runbook in the [root `README.md`](../README.md). For building from source /
contributing, see [`docs/DEVELOPMENT.md`](DEVELOPMENT.md).

The production bundle lives under `deploy/` (`docker-compose.yml`, `.env.example`, `Caddyfile`);
it pulls the published image from GHCR and fronts it with Caddy for TLS. The root
`docker-compose.yml` is the dev/contributor file that builds from source.

## Environment variables

Set operator vars in `deploy/.env` (copied from `deploy/.env.example`). The canonical var list
is **SPEC.md §12**; per-var defaults live in [`server/.env.example`](../server/.env.example).
Required vars use Compose's `${VAR:?}` so `docker compose up` **fails fast** if unset.

| Var | Required? | Default | Notes |
| --- | --- | --- | --- |
| `PUBLIC_HOST` | **yes** | — (`:?` fails) | Real routable IPv4/hostname; the WebRTC ICE announce address (SPEC.md §11). **Never `localhost`** — remote voice silently fails. |
| `CADDY_SITE` | **yes** | — (`:?` fails) | Public domain Caddy serves TLS for (e.g. `discord.example.com`). DNS `A`/`AAAA` must resolve to this host before bring-up. |
| `SERVER_IMAGE_TAG` | no | `latest` | Image tag to pull. **Pin a released version (e.g. `0.2.0`) in prod.** |
| `CADDY_ACME_EMAIL` | no | empty | ACME account / cert-expiry email. Caddy issues without it. |
| `RTC_EXTRA_ANNOUNCED_IPS` | no | empty | Extra ICE candidate IPs (comma-separated), e.g. a LAN IP. Each consumes one more UDP port per transport. |
| `MAX_UPLOAD_MB` | no | `10` | Max image upload size (MB). |
| `SESSION_TTL` | no | `604800` | Session lifetime (seconds). |
| `AUTH_RATE_MAX` | no | `10` | Auth-endpoint rate-limit max per IP. |
| `AUTH_RATE_WINDOW_MS` | no | `60000` | Auth rate-limit window (ms). |
| `MAX_MESSAGE_LENGTH` | no | `4000` | Max message length (chars). |
| `MSG_HISTORY_DEFAULT_LIMIT` | no | `50` | Default message-history page size. |
| `MSG_HISTORY_MAX_LIMIT` | no | `100` | Max message-history page size. |

Fixed in `deploy/docker-compose.yml` (literals in `server.environment`, not env-tunable):

| Var | Value |
| --- | --- |
| `RTC_MIN_PORT` | `40000` |
| `RTC_MAX_PORT` | `40010` |
| `DATA_DIR` | `/data` |
| `NODE_ENV` | `production` |
| `HTTP_PORT` | `8080` |

> `RTC_MIN_PORT`/`RTC_MAX_PORT` **MUST equal** the compose UDP `40000-40010` port mapping (and
> the firewall/router forward). Don't change one without the other.

## Supported image architecture

```
linux/amd64, glibc (Debian bookworm)  ONLY
```

The image is **amd64/glibc only — NOT arm64, NOT musl/alpine.** This is a hard runtime
constraint: the mediasoup SFU worker is a glibc-linked native binary (SPEC.md §11) and won't run
under musl, and `better-sqlite3` is compiled for the image's Node ABI. Pulling it on an arm64
host will not run.

Tags published per release:

- `ghcr.io/tdmiller1/discord-clone-server:<version>` — the specific release; **pin this in prod**.
- `ghcr.io/tdmiller1/discord-clone-server:latest` — re-pointed to the newest release; convenience
  only, not a substitute for pinning.

## Backup & restore (`/data`)

The named volume `discord-data` mounts at the server's `/data` and holds the **SQLite database
plus uploaded image files** (SPEC.md §8 — images live under `/data/images/<id>`). **Nothing
voice-related is persisted** — the SFU keeps only ephemeral in-memory state, so a backup of
`/data` is a complete backup of everything durable (users, sessions, invite tokens, channels,
messages, attachments).

SQLite is the source of truth and a live file. For a consistent snapshot, **quiesce the server
first** (`docker compose stop server`), back up, then start it again. (Caddy can keep running.)

Back up `/data` to a tarball on the host using a throwaway container that mounts the volume:

```sh
cd deploy
docker compose stop server                                    # quiesce for a consistent snapshot
docker run --rm \
  -v deploy_discord-data:/data:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/discord-data-backup.tar.gz -C /data .
docker compose start server
```

Restore into a fresh volume (server stopped), then bring the stack up:

```sh
cd deploy
docker compose down                                           # stop the stack
docker volume create deploy_discord-data                      # no-op if it already exists
docker run --rm \
  -v deploy_discord-data:/data \
  -v "$PWD":/backup \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/discord-data-backup.tar.gz -C /data"
docker compose up -d
```

> The volume name Compose creates is `<project>_discord-data`; for the `deploy/` bundle the
> project name defaults to the directory (`deploy`), giving `deploy_discord-data`. Confirm with
> `docker volume ls`. There is no app-specific dump/restore command — use these Docker volume
> mechanics.

## User & token management

The admin CLI is `server/src/cli.ts`, run inside the server container. Use the `node dist/cli.js`
form — the package's `server` bin is **not** on the runtime image `PATH`, so `docker exec <ctr>
server mint-token` fails ("executable file not found in $PATH"); `node dist/cli.js` (run from the
image WORKDIR `/app`) works.

```sh
docker compose exec server node dist/cli.js mint-token              # single-use invite token
docker compose exec server node dist/cli.js revoke-user <username>  # disable account + kill its sessions
docker compose exec server node dist/cli.js revoke-token <id>       # revoke an unused invite token by id
```

- **`mint-token`** — generates a single-use invite token and prints the **raw token once**
  (stored hashed at rest). Hand it to the user who will register with it.
- **`revoke-user <username>`** — sets the account `disabled` and revokes all of that user's
  sessions (logs them out everywhere). Prints how many sessions were revoked.
- **`revoke-token <id>`** — revokes an **unused** invite token by its numeric `id`. Errors if no
  unused token with that id exists.

There are no other subcommands or flags. Onboarding is purely token-based (SPEC.md §6): there is
**no admin-bootstrap credential and no log line** — SPEC.md §12's "first boot generates an admin
bootstrap credential printed to logs" clause is unimplemented. The first user to register with a
minted token creates the first account.

## Voice / ICE troubleshooting

Typical symptom: text, images, and `/health` all work, but **voice is silent**. Voice media is
raw DTLS-SRTP UDP that bypasses Caddy and goes straight to the host, so it has its own failure
modes:

1. **`PUBLIC_HOST` must be the real routable host — never `localhost`.** It is the address the
   SFU announces as its ICE candidate (`announcedIp`, SPEC.md §11). If it's `localhost` or an
   unroutable value, remote clients receive an unreachable candidate and never establish media.
   For on-LAN clients that need a direct candidate, add the host's LAN IP via
   `RTC_EXTRA_ANNOUNCED_IPS` (each extra IP consumes one more UDP port/transport from the range).
2. **The UDP media range `40000-40010` must be reachable directly.** Allow it in the host
   firewall and **UDP-forward it on the router** to the host. It is raw DTLS-SRTP — Caddy (and
   any tunnel) only carries TCP 80/443, so it never proxies the media.
3. **WSS upgrade must survive the proxy.** The gateway and voice signaling ride
   `wss://<CADDY_SITE>/ws`. Caddy's `reverse_proxy` forwards the `Upgrade`/`Connection` headers
   automatically, but a custom/misconfigured proxy that drops them breaks the WS gateway even
   though `/health` still returns 200.

## TLS options

**Caddy is the primary documented TLS path** (SPEC.md §12): it auto-provisions and renews a
Let's Encrypt cert for `CADDY_SITE` and reverse-proxies the single origin
(`https://<CADDY_SITE>` for `/`, `/health`, `/api/*`, attachment streams; `wss://<CADDY_SITE>/ws`
for the gateway + voice signaling).

**Escape hatch — bring your own proxy.** Any external TLS reverse proxy works instead, including
the existing Cloudflare tunnel, as long as it (1) terminates TLS and forwards the WebSocket
`Upgrade` on the same origin so `wss://<host>/ws` reaches `server:8080`, and (2) lets the UDP
media range (`40000-40010`) reach the `server` container directly. **The tunnel does not carry
UDP — a direct router UDP forward to `PUBLIC_HOST` is still required.**
