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

## Running it

Three ways in, depending on who you are:

- **Deploy a public server (recommended) — root `docker-compose.yml`.** Pulls the published
  **server image from GHCR**, builds the hosted web client, and runs a **Cloudflare Tunnel** that
  publishes both over **HTTPS/WSS** with **no inbound TCP ports** opened and **no TLS certificates
  to manage**. Voice runs over a **direct UDP port forward** on your router. This is the path the
  **[Deploy runbook](#deploy-cloudflare-tunnel--udp-voice-recommended)** below walks through.
- **Run your own TLS instead (alternative) — `deploy/docker-compose.yml`.** Pulls the published
  GHCR image and fronts it with Caddy (automatic Let's Encrypt) for a domain whose DNS points
  directly at the host. See **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)**.
- **Build / hack on it from source — [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).**

## Deploy: Cloudflare Tunnel + UDP voice (recommended)

The recommended way to run a public server. A **Cloudflare Tunnel** publishes the API/gateway and
the hosted web client over HTTPS/WSS — you open **no inbound TCP ports**, point **no DNS at your
home IP**, and **never touch a certificate**. The *only* thing you forward on the router is the
**UDP voice range**, because WebRTC media can't ride the tunnel (and shouldn't).

> Prefer to terminate TLS yourself with a domain pointed straight at the host? Use the `deploy/` +
> Caddy bundle instead — [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Everything below assumes the
> tunnel path.

Examples use `<version>` placeholders; the current release is `0.3.0` (tag `v0.3.0`). Substitute
the version you're deploying, and your own domain for `example.com`.

### Prerequisites

- A host with **Docker + Compose**, **amd64 / glibc** — **NOT arm64, NOT musl/alpine** (the
  mediasoup SFU worker is a glibc native binary and `better-sqlite3` is compiled for the image's
  Node ABI; it will not run on arm64).
- A **Cloudflare account** with a domain on it (a free zone works) and a **Cloudflare Tunnel** —
  you'll paste its connector token into `.env`.
- Router access to **port-forward UDP `40000-40010`** to the host — the voice path (step 4).

### 1. Create the Cloudflare Tunnel

In the Cloudflare **Zero Trust** dashboard → **Networks → Tunnels**, create a tunnel and copy its
**connector token**. Add two **Public Hostnames**. Because `cloudflared` runs on **host
networking**, each origin must be `http://localhost:<port>` — *not* a compose service name:

| Public hostname | Service (origin) | Serves |
| --- | --- | --- |
| `discord.example.com` | `http://localhost:8080` | API + WebSocket gateway (incl. voice signaling) |
| `app.example.com` | `http://localhost:8083` | hosted web client |

> Adding or renaming one Public Hostname can delete the other's DNS record — keep **both**.

### 2. Configure the root `.env`

```sh
cp .env.example .env
$EDITOR .env
```

| Var | Set to | Why |
| --- | --- | --- |
| `CLOUDFLARE_TUNNEL_TOKEN` | the tunnel connector token | Lets `cloudflared` dial out and publish the hostnames. |
| `PUBLIC_HOST` | your **real public IPv4** | The address the SFU advertises as its WebRTC ICE candidate. **Never `localhost`** — voice silently fails (text/images/`/health` still look fine). |
| `VITE_SERVER_URL` | `https://discord.example.com` | Baked into the hosted web client so it targets the public API by default. |
| `VITE_APP_URL` | `https://app.example.com` | Baked in so the in-app **"Invite a friend"** button builds shareable links back to the hosted client. |
| `RTC_EXTRA_ANNOUNCED_IPS` | host's LAN IP *(optional)* | A second ICE candidate so same-LAN clients connect directly instead of hairpinning the public IP. |
| `SERVER_IMAGE_TAG` | release tag *(optional)* | Which published server image to pull (default `latest`); pin e.g. `0.3.1` for stability. |

`.env` is gitignored — your tunnel token and public IP never get committed.

### 3. Bring up the stack

```sh
docker compose up -d --build      # or: npm run docker:up
```

Three services come up: `server` (the published API/gateway image **pulled from GHCR** — tag
`SERVER_IMAGE_TAG`, default `latest`), `web` (the hosted client, built locally by `--build`), and
`cloudflared` (the tunnel). Within ~a minute both hostnames serve over real HTTPS:

```sh
curl -sf https://discord.example.com/health     # 200, through the tunnel
```

To update later, `docker compose pull && docker compose up -d` grabs the newest released server
image — or bump `SERVER_IMAGE_TAG` to pin a specific version.

**HTTPS/WSS is required** (SPEC.md §12); the tunnel provides it for free. The client derives
`wss://discord.example.com/ws` from the `https://` URL automatically — you never enter a separate
WebSocket URL.

### 4. Forward the UDP voice range (the one thing the tunnel can't carry)

WebRTC media is raw **DTLS-SRTP over UDP** and **does not traverse the Cloudflare Tunnel** — the
tunnel only carries the HTTPS/WSS (TCP) traffic. Voice therefore needs a **direct UDP port
forward**:

- On your router, **forward UDP `40000-40010`** to the Docker host.
- Set a **DHCP reservation** for the host so the forward survives a lease change.
- That range must match `RTC_MIN_PORT`-`RTC_MAX_PORT` and the compose UDP mapping (both pinned to
  `40000-40010`).

The direct UDP forward **plus** `PUBLIC_HOST` set to your real public IPv4 are exactly what make
voice work — everything else rides the tunnel.

### 5. Mint an invite token

Onboarding is purely **token-based** (SPEC.md §6): the admin mints a single-use invite token, and
the **first user to register** with it creates the account.

```sh
docker compose ps                                        # show the running services
docker compose exec server node dist/cli.js mint-token   # prints a one-time token
```

The token is single-use and printed once — copy it, then hand it to the user. (Logged-in users can
also generate invite links in-app via **"Invite a friend"**.) See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for `revoke-user` / `revoke-token`.

> **No admin-bootstrap log line.** SPEC.md §12 mentions a "first boot generates an admin bootstrap
> credential printed to logs"; that clause is **unimplemented**. There is no separate admin account
> — the real flow is mint-token → the first user registers. Don't go looking for a credential in
> the logs.

### 6. Get users connected

Two ways for a user to get in:

- **Hosted web client (no install):** open `https://app.example.com` in a browser — the server URL
  is already baked in.
- **Desktop app:** download the installer for their OS from the GitHub Release:
  - This version: `https://github.com/tdmiller1/discord-clone/releases/tag/v<version>`
  - Latest: `https://github.com/tdmiller1/discord-clone/releases/latest`

  | OS | Format | Asset filename | Install action |
  | --- | --- | --- | --- |
  | Windows | MSI installer | `discord-clone_<version>_x64_en-US.msi` | double-click to install |
  | Windows | NSIS setup `.exe` | `discord-clone_<version>_x64-setup.exe` | double-click to install |
  | Linux | AppImage (portable) | `discord-clone_<version>_amd64.AppImage` | `chmod +x` then run directly |
  | Linux | Debian package | `discord-clone_<version>_amd64.deb` | `sudo apt install ./<file>.deb` |

  For `v0.3.0`: `discord-clone_0.3.0_x64_en-US.msi`, `discord-clone_0.3.0_x64-setup.exe`,
  `discord-clone_0.3.0_amd64.AppImage`, `discord-clone_0.3.0_amd64.deb`. **amd64 / x64 only** —
  there are no arm64 or macOS builds.

  > **Installers are unsigned.** Expect a Windows SmartScreen warning ("Windows protected your PC" →
  > More info → Run anyway) and a Linux "untrusted AppImage" prompt. Both are normal and must be
  > explicitly allowed.

On first launch the desktop client asks for a **server URL** (`https://discord.example.com`), the
**invite token** from step 5, and a desired username + password. Registering consumes the token and
opens a session; thereafter the user logs in with username + password.

### 7. Confirm it works end-to-end

- **Text** — open a text channel and send a message.
- **Images** — upload an image and confirm it renders inline in the message list.
- **Voice** — join the single voice channel from a second client and confirm two-way audio.

> **Text/images/`/health` work but voice is silent?** Almost always either `PUBLIC_HOST` set to
> `localhost`/an unroutable value, or the UDP `40000-40010` range not **forwarded on the router** to
> the host. Voice media is raw DTLS-SRTP UDP sent straight to `PUBLIC_HOST`, bypassing the tunnel
> entirely. See the voice/ICE troubleshooting in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
