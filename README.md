# discord-clone

No fluff, "discord server" clone.

## High Level

Artifacts
1. Discord server image configuration
    - Docker container to be run on any bare metal server with low effort config
2. Discord client application exe
    - Easy for anyone to download and install
3. Discord client application (exe but for Linux)
    - Easy for anyone to download and install

Assume very simple architecture, 1 server only needs to support up to 10 clients. E.g One technically minded user spins up the server and deals out the authentication tokens to be used during the Client exe install

## Features

- Basic text channel
- Ability to create new text channels
- Basic VOIP channel
- Ability to view + send images

## Dev vs prod

Two compose files, two audiences — don't mix them up:

- **Contributors building from source** use the **root `docker-compose.yml`** (`build: ./server`,
  `PUBLIC_HOST: localhost`, no TLS) — see **[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)**.
- **Admins deploying the published image** use **`deploy/docker-compose.yml`** (pulls the GHCR
  image + fronts it with Caddy for automatic TLS) — follow the runbook below, with
  **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)** as the operations reference.

## Deploy (admin runbook)

This stands up a public **HTTPS/WSS** server with text, inline images, and voice using the
**published server image** + Caddy (automatic Let's Encrypt TLS), then walks a user through
installing the client and confirming everything works end-to-end. If you're building from
source instead, see **[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)** — not this section.

Examples below use `<version>` placeholders; the first release is `0.2.0` (tag `v0.2.0`).
Substitute the version you're deploying.

### Prerequisites

- A host with **Docker + Compose**.
- A **domain** whose DNS `A`/`AAAA` record already resolves to the host — Caddy needs this to
  issue a Let's Encrypt cert for it before bring-up.
- The UDP media range **`40000-40010/udp`** allowed in the host firewall **and** router-forwarded
  directly to the host. Voice media is raw DTLS-SRTP UDP that bypasses Caddy (see step 6).
- An **amd64 / glibc** host. The image is **`linux/amd64, glibc` ONLY — NOT arm64, NOT
  musl/alpine** (the mediasoup SFU worker is a glibc native binary and `better-sqlite3` is
  compiled for the image's Node ABI). It will not run on arm64.

### 1. Deploy the server (prod compose, pulls the published image)

From the production bundle under `deploy/`:

```sh
cd deploy
cp .env.example .env
$EDITOR .env            # set PUBLIC_HOST, CADDY_SITE (+ SERVER_IMAGE_TAG, CADDY_ACME_EMAIL)
# if the GHCR package is private: docker login ghcr.io -u tdmiller1
docker compose up -d
```

Set these in `deploy/.env`:

- `PUBLIC_HOST` — **required.** The real routable IPv4/hostname the SFU advertises as its
  WebRTC ICE announce address. **Never `localhost`** — remote voice silently fails (text,
  images, and `/health` still look fine).
- `CADDY_SITE` — **required.** The public domain Caddy serves TLS for (e.g.
  `discord.example.com`). Its DNS must resolve to this host before bring-up.
- `SERVER_IMAGE_TAG` — optional, defaults to `latest`. **Pin a released version (e.g. `0.2.0`)
  in prod** rather than tracking `latest`.
- `CADDY_ACME_EMAIL` — optional. ACME account / cert-expiry email.

Both required vars use Compose `${VAR:?}`, so `docker compose up` **fails fast** if either is
unset. The image pulled is `ghcr.io/tdmiller1/discord-clone-server:${SERVER_IMAGE_TAG:-latest}`.
See **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)** for the full env-var reference.

The GHCR package may be **private on first publish** — anonymous `docker pull` fails until you
either authenticate the host:

```sh
echo "<PAT-with-read:packages>" | docker login ghcr.io -u tdmiller1 --password-stdin
```

(a Personal Access Token with `read:packages`), or make the package public:
GitHub → Profile → Packages → `discord-clone-server` → Package settings → Danger Zone →
Change visibility → **Public**.

### 2. Confirm HTTPS/WSS (Caddy auto-TLS)

Caddy auto-issues a Let's Encrypt cert for `CADDY_SITE` and reverse-proxies to `server:8080`,
forwarding the WebSocket `Upgrade` automatically (no manual header config). Verify the stack is
up and serving over a real cert:

```sh
curl -sf https://<CADDY_SITE>/health     # 200 over the proxy, real cert
```

**HTTPS/WSS is required** (SPEC.md §12) — a plain `http://`/`ws://` setup breaks the client.

> **Bring your own proxy (escape hatch).** Caddy is the primary documented TLS path, but any
> external TLS proxy works — including the existing Cloudflare tunnel — as long as it forwards
> the WebSocket `Upgrade` on the same origin so `wss://<host>/ws` reaches `server:8080`, **and**
> the UDP media range still reaches the container directly. The tunnel never carries UDP, so a
> direct router UDP forward to `PUBLIC_HOST` is still required.

### 3. Mint an invite token (real CLI)

Onboarding is purely **token-based** (SPEC.md §6): the admin mints a single-use invite token,
and the **first user to register** with it creates the first account. Find the running server
service, then mint a token:

```sh
docker compose ps                                        # show the running services
docker compose exec server node dist/cli.js mint-token   # prints a one-time token
```

(Equivalently, with the raw container name: `docker exec <ctr> node dist/cli.js mint-token`.)
The token is single-use and printed once — copy it, then hand it to the user. See
**[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)** for `revoke-user` / `revoke-token`.

> **Note — no admin-bootstrap log line.** SPEC.md §12 mentions a "first boot generates an admin
> bootstrap credential printed to logs"; that clause is **unimplemented**. There is no separate
> admin account and no such log line — the implemented flow (SPEC.md §6) is exactly mint-token →
> the first user registers. Don't go looking for a credential in the logs.

### 4. Download + install the client (GitHub Release)

Each release attaches the client installers to a GitHub Release:

- This version: `https://github.com/tdmiller1/discord-clone/releases/tag/v<version>`
  (e.g. `https://github.com/tdmiller1/discord-clone/releases/tag/v0.2.0`)
- Latest: `https://github.com/tdmiller1/discord-clone/releases/latest`

Pick the asset for your OS by exact filename:

| OS | Format | Asset filename | Install action |
| --- | --- | --- | --- |
| Windows | MSI installer | `discord-clone_<version>_x64_en-US.msi` | double-click to install |
| Windows | NSIS setup `.exe` | `discord-clone_<version>_x64-setup.exe` | double-click to install |
| Linux | AppImage (portable) | `discord-clone_<version>_amd64.AppImage` | `chmod +x` then run directly |
| Linux | Debian package | `discord-clone_<version>_amd64.deb` | `sudo apt install ./<file>.deb` |

For `v0.2.0` those are `discord-clone_0.2.0_x64_en-US.msi`, `discord-clone_0.2.0_x64-setup.exe`,
`discord-clone_0.2.0_amd64.AppImage`, and `discord-clone_0.2.0_amd64.deb`. **amd64 / x64 only**
— there are no arm64 or macOS builds.

> **Installers are unsigned.** Expect a Windows SmartScreen warning ("Windows protected your
> PC" → More info → Run anyway) and a Linux "untrusted AppImage" prompt. These are normal and
> must be explicitly allowed.

### 5. Register → login → connect

On first launch the client asks for a server URL, an invite token, and a desired username +
password:

1. Server URL: `https://<CADDY_SITE>`.
2. Paste the invite token from step 3, choose a username + password → registers (consumes the
   token) and opens a session.
3. Thereafter, log in with username + password.

The client derives `wss://<CADDY_SITE>/ws` from the `https://` URL automatically — you do not
enter a separate WebSocket URL.

### 6. Confirm it works end-to-end

- **Text** — create or open a text channel and send a message.
- **Images** — upload an image and confirm it renders inline in the message list.
- **Voice** — join the single voice channel from a second client and confirm two-way audio.

> **If text/images/`/health` work but voice is silent**, the cause is almost always
> `PUBLIC_HOST` set to `localhost`/an unroutable value, or the UDP `40000-40010` range not being
> firewall-open and router-forwarded to the host. Voice media is raw DTLS-SRTP UDP sent directly
> to `PUBLIC_HOST`, bypassing Caddy entirely. See the voice/ICE troubleshooting in
> **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)**.