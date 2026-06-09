# discord-clone — Project Specification

Status: **draft for review**. This spec defines *what* we're building and the contracts
between parts. Final stack choices for the server and frontend framework are in
[§13 Open decisions](#13-open-decisions); everything above that is settled.

---

## 1. Overview & goals

A self-hosted, "no fluff" Discord-server clone. One technically-minded admin runs a single
server; up to ~10 people connect with a desktop client.

Three shipped artifacts:

1. **Server image** — a Docker container that runs on any bare-metal box with low-effort config.
2. **Windows client** — downloadable, installable `.exe`/`.msi`.
3. **Linux client** — downloadable, installable `.AppImage` (and optional `.deb`).

Core features:
- Text channels; create new text channels.
- Send/view images inline.
- One basic VOIP channel (extendable to more later).

## 2. Constraints & non-goals

**Constraints**
- Single server instance, **≤10 concurrent clients**. No horizontal scaling, sharding, message
  brokers, or microservices — keep the surface area small.
- Admin bootstraps the server and **issues invite tokens** out-of-band to each user.
- Low-effort deploy: one `docker compose up` (or `docker run`) with a volume + a few env vars.

**Non-goals (v1)** — explicitly out of scope to keep it simple:
- Federation / multiple servers / server discovery.
- Roles & granular permissions (one flat member role + one admin).
- DMs, threads, reactions, replies, deletes history, search. (Authors **can** edit their own message text — see §7/§9 — but there is no edit *history*; only the latest text and an `edited_at` stamp are kept.)
- Screen share, video, voice for >1 channel concurrently is allowed but not a priority.
- Mobile/web clients (desktop only per README).

## 3. Confirmed decisions

| Area | Decision | Implication |
|------|----------|-------------|
| Desktop client | **Tauri** (Rust shell + OS webview) | Small binaries, native packaging for Win/Linux; WebRTC runs in the system webview. |
| Identity / tokens | **Token-bootstrapped accounts** | Invite token → one-time registration of `username`+`password`. Afterwards users log in with credentials. Supports reinstall/multi-device and **per-user revoke**. |
| Voice transport | **Server-routed WebRTC (SFU-lite)** | All audio flows through the server, which forwards to other participants. Robust over the internet; one media port range to open. |

## 4. System architecture

```
                        ┌──────────────────────────────────────────┐
                        │            Docker container                │
   Tauri client(s)      │                                            │
 ┌──────────────┐  HTTPS │  ┌──────────┐  ┌──────────────┐           │
 │  Webview UI  │◀──────▶│  │  REST API │  │ WebSocket    │           │
 │ (TS frontend)│  WSS    │  │ auth/img │  │ gateway      │           │
 │              │◀──────▶│  │ channels │  │ (msgs/presence│          │
 │  Rust shell  │         │  └────┬─────┘  │  + signaling)│           │
 │ (keychain,   │         │       │        └──────┬───────┘           │
 │  packaging)  │  WebRTC │       │               │                   │
 │   getUserMedia│◀──────▶│  ┌────▼───────────────▼─────┐             │
 └──────────────┘  (Opus  │  │   SFU (audio forwarding)  │            │
                    media) │  └───────────────────────────┘           │
                          │       │                                    │
                          │  ┌────▼────┐   ┌────────────────────┐      │
                          │  │ SQLite  │   │ /data image volume  │     │
                          │  └─────────┘   └────────────────────┘      │
                          └────────────────────────────────────────────┘
```

**Server responsibilities**
- **REST API**: register (token→account), login, session refresh/logout, channel list/create,
  message history fetch, image upload/download, admin token mint/revoke.
- **WebSocket gateway**: live message send/receive, presence (online + in-voice state),
  channel events, and WebRTC signaling (SDP offer/answer + ICE).
- **SFU**: receive each speaker's Opus stream, forward to the other participants in the voice channel.
- **Persistence**: SQLite (single file) + image files on a mounted volume.

**Client responsibilities**
- Webview frontend renders all UI and owns WebRTC (`getUserMedia` / `RTCPeerConnection`).
- Tauri Rust shell: secure credential/session storage (OS keychain), config (server URL),
  window management, and packaging/auto-update.

## 5. Deliverables & packaging

| Artifact | Build output | Notes |
|----------|--------------|-------|
| Server | OCI image (`docker build`) + `docker-compose.yml` | Volumes: `/data` (SQLite + images). Ports: HTTPS/WSS, media UDP range. |
| Windows client | `.msi` + NSIS `.exe` | Produced by `tauri build`. |
| Linux client | `.AppImage` (+ optional `.deb`) | Produced by `tauri build`. |

CI builds all three from tagged releases (matrix: windows-latest, ubuntu-latest, plus image build).

## 6. Auth & identity flows

**Token-bootstrapped accounts:**

1. **Mint** — admin runs a server command to mint an invite token:
   `docker exec <ctr> server mint-token` → prints an opaque token (stored **hashed** at rest, single-use).
2. **Register** — on first launch the client asks for: server URL, invite token, desired
   username, password. `POST /api/register {token, username, password}` →
   server validates+consumes the token, creates the user (Argon2id password hash), returns a session.
3. **Login** — thereafter `POST /api/login {username, password}` → session.
4. **Session** — opaque random session token stored server-side (row in `sessions`) so an admin can
   revoke instantly; sent as `Authorization: Bearer <session>` and on WS connect. Sessions have an
   expiry + refresh.
5. **Revoke** — `server revoke-user <username>` disables the account and kills its sessions.

Client stores the session token (not the password) in the OS keychain via the Tauri shell.

## 7. Realtime protocol (WebSocket)

JSON envelope: `{ "op": "<event>", "d": { ... } }`. Client authenticates on connect with the session token.

| op (server→client) | payload | meaning |
|--------------------|---------|---------|
| `ready` | user, channels, members | initial state after auth |
| `message.create` | message | new message in a channel |
| `message.update` | message | a message's text was edited |
| `channel.create` | channel | a channel was created |
| `presence.update` | userId, status, voiceChannelId | online/offline / joined-left voice |
| `voice.signal` | from, sdp/ice | SFU negotiation relayed |

| op (client→server) | payload | meaning |
|--------------------|---------|---------|
| `message.send` | channelId, content, attachmentId? | post a message |
| `message.edit` | messageId, content | edit your own message's text |
| `voice.join` / `voice.leave` | channelId | enter/leave the voice channel |
| `voice.signal` | sdp/ice | negotiation |
| `voice.state` | muted, deafened | self mute/deafen |

(History and image upload go over REST, not WS — see §9, §10.)

## 8. Data model (SQLite)

- **users**: `id, username UNIQUE, password_hash, display_name, created_at, disabled, avatar_attachment_id NULL` (FK → attachments; current profile picture)
- **invite_tokens**: `id, token_hash, created_by, created_at, used_by NULL, used_at NULL, revoked`
- **sessions**: `id, user_id, token_hash, created_at, expires_at, revoked`
- **channels**: `id, name, type (text|voice), position, created_by, created_at`
- **messages**: `id, channel_id, author_id, content, attachment_id NULL, created_at, edited_at NULL`
- **attachments**: `id, message_id NULL, uploader_id, filename, content_type, size, width, height, path, created_at`

## 9. Text channels & messages

- Any member can create a text channel (`POST /api/channels {name, type:"text"}`) → broadcast `channel.create`.
- Channel names are normalized server-side: trimmed, with each run of whitespace collapsed to a single `-` (no spaces). The client mirrors this live in the create field; the server stays authoritative.
- Send: `message.send` over WS → persisted → broadcast `message.create` to channel members.
- Edit: `message.edit {messageId, content}` over WS → server checks the editor is the **author**, updates `content` + stamps `edited_at` → broadcast `message.update` (full message) to all. Editing to empty text is allowed only when the message still carries an attachment. Clients show an `(edited)` marker when `edited_at` is set.
- History: `GET /api/channels/:id/messages?before=<cursor>&limit=50` (keyset pagination on `id`).
- Ordering by server-assigned monotonic `id`/`created_at`. Plain text content in v1 (no markdown/mentions).

## 10. Images / attachments

- Upload (REST, multipart): `POST /api/attachments` → server validates type/size, stores file under
  `/data/images/<id>`, records row, returns `{attachmentId}`. Then `message.send` references it.
- Download/stream: `GET /api/attachments/:id` (auth-checked), correct `Content-Type`.
- Limits: allow `image/png|jpeg|gif|webp`; max size (default **10 MB**, configurable). Thumbnails optional/deferred.
- Client renders images inline in the message list.
- **Profile pictures** reuse this pipeline: `PATCH /api/users/me/avatar` (multipart, same
  validation) stores the image as an unlinked attachment, points `users.avatar_attachment_id`
  at it (reclaiming the previous one), and broadcasts `user.update` so every client refreshes
  the picture live. `PublicUser` carries `avatarId`; clients fetch the bytes via
  `GET /api/attachments/:id` like any inline image. Falls back to a name-derived initial when unset.

## 11. Voice (SFU-lite) flow

1. Client sends `voice.join {channelId}` → server allocates SFU transport, replies with params.
2. WebRTC negotiation: offer/answer + ICE candidates relayed via `voice.signal` over the WS.
3. Client publishes its mic as an **Opus** track to the server; the server forwards each participant's
   track to the others in that channel (selective forwarding — no client-side mesh).
4. `voice.state` propagates mute/deafen; `presence.update` shows who's in voice.
5. Leaving / disconnecting tears down the transport and updates presence.

Networking: the host must expose the HTTPS/WSS port and a **UDP media port range** (e.g. `40000–40100`).
The server's public IP/hostname is set as the ICE announce address. Because audio is server-routed,
no external TURN is required as long as the server is reachable.

## 12. Security & deployment

- **Passwords**: Argon2id. **Tokens/sessions**: random, stored hashed, single-use invite tokens.
- **Transport**: HTTPS/WSS required. Recommend fronting with **Caddy** for automatic Let's Encrypt
  TLS, or supply a cert. WebRTC media is DTLS-SRTP encrypted by default.
- **Rate-limit** auth endpoints; validate/limit uploads; size-limit WS frames.
- **Config (env vars)**: `PUBLIC_HOST`, `HTTP_PORT`, `RTC_MIN_PORT`/`RTC_MAX_PORT`,
  `DATA_DIR=/data`, `MAX_UPLOAD_MB`, `SESSION_TTL`, `AUTH_RATE_MAX`/`AUTH_RATE_WINDOW_MS`
  (auth-endpoint rate limit; optional, sane defaults). First boot generates an admin bootstrap
  credential printed to logs.
- **Deploy**: `docker compose up -d` with a `/data` volume and the ports above. Admin then mints tokens.

## 13. Open decisions

These don't block the spec but must be settled before scaffolding + CLAUDE.md. Recommendations given.

1. **Server stack** — _Recommended:_ **Node + TypeScript** (Fastify HTTP, `ws` gateway,
   **mediasoup** SFU, `better-sqlite3`, Argon2). Rationale: the webview frontend is TypeScript
   already, so this keeps one primary language across server + UI, and mediasoup is the most
   battle-tested Node SFU. _Alternatives:_ **Go + Pion** (single static binary, leanest image, adds a
   3rd language) or **Rust + axum + webrtc-rs** (unifies with the Tauri shell; SFU libs less mature).
2. **Frontend framework** (inside the webview) — _Recommended:_ **Svelte + TypeScript** for lean
   bundles; **React + TS** is an equally fine, bigger-ecosystem alternative. Low-stakes, reversible.
3. **Voice scope** — confirm a **single** voice channel for v1 (data model already supports N voice
   channels; just limiting UI/SFU rooms to one keeps it simple).

## 14. Build order (milestones)

| # | Milestone | Acceptance |
|---|-----------|------------|
| M0 | Scaffold: server skeleton, Tauri client skeleton, Dockerfile, CI matrix | `docker compose up` serves health check; `tauri build` produces installers on both OSes. |
| M1 | Auth + WS connect + presence | Mint token → register in client → login → see online members update live. |
| M2 | Text channels | Create channel, send/receive messages live, reload shows persisted history. |
| M3 | Images | Upload an image in a message; other clients see it inline; survives reload. |
| M4 | Voice (SFU) | Two clients join the voice channel and hear each other; mute works; presence shows who's in. |
| M5 | Release & docs | Tagged release publishes server image + Windows/Linux installers; README deploy steps verified end-to-end. |
