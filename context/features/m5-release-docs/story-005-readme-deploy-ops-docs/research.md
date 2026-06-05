#research

# Research: Verified README deploy runbook + operations docs

## Files to Touch

### Likely Modified
- `README.md` (root) — currently a ~20-line high-level stub (artifacts list + feature bullets, no deploy steps). Expand into the deploy runbook: prod compose bring-up → TLS via Caddy → mint invite token → download/install client from the GitHub Release → register/login → confirm text + images + voice. Must also draw the dev-vs-prod line (point contributors to `docs/DEVELOPMENT.md` + root dev compose; admins to `deploy/`). Keep the existing high-level intro; append the runbook.
- `docs/DEVELOPMENT.md` (optional, minor) — add a one-line cross-link from the dev doc to the new ops/deploy doc so the dev↔prod boundary is symmetric. Its CI section is slightly stale (says installers upload as "artifacts"; story 003 makes a tagged release attach them) — a small accuracy touch-up is in scope but not required by the AC.

### Likely Created
- `docs/DEPLOYMENT.md` (or `docs/OPERATIONS.md`) — the operations reference required by AC line 4. Must cover: env-var reference (cross-link `SPEC.md §12` + `server/.env.example` + `deploy/.env.example`), `/data` backup & restore (SQLite DB + image files; nothing voice-related persisted, `§8`), user/token management (`revoke-user`, `revoke-token`), supported image arch (amd64/glibc only), and voice/ICE troubleshooting (`PUBLIC_HOST`/announcedIp, UDP range, WSS-upgrade-through-proxy). Recommend `docs/DEPLOYMENT.md` — the feature spec names it explicitly ("backed by a `docs/DEPLOYMENT.md` operations reference").

This is docs-only — **no TypeScript, no compose/Caddy edits** (those are story 004's, already on disk and treated as fixed). `npm run typecheck` must stay green (AC line 7); it will trivially, since no TS changes.

### Read-Only Reference (patterns to follow)
- `docs/DEVELOPMENT.md` — the canonical doc-style template in this repo: `#` title, short prose lead-in, `## Section` headings, fenced ```bash blocks with one command per line and a trailing `# comment` explaining intent, and a `>` callout block for gotchas. Mirror this exactly in README runbook + DEPLOYMENT.md.
- `deploy/docker-compose.yml`, `deploy/.env.example`, `deploy/Caddyfile` — story-004 artifacts already on disk. The runbook's bring-up steps must match these verbatim (service names `server`/`caddy`, required `${VAR:?}` vars, the `40000-40010/udp` mapping, the `cd deploy && cp .env.example .env` flow). The `.env.example` already contains the exact comments to paraphrase (PUBLIC_HOST-never-localhost, UDP-router-forward, GHCR-private login line).
- `server/.env.example` — authoritative per-var defaults the DEPLOYMENT.md env table cross-links: `MAX_UPLOAD_MB=10`, `SESSION_TTL=604800`, `AUTH_RATE_MAX=10`, `AUTH_RATE_WINDOW_MS=60000`, `RTC_MIN_PORT/MAX_PORT=40000/40010`, plus `MAX_MESSAGE_LENGTH`, `MSG_HISTORY_*`.
- `server/src/cli.ts` — the real admin CLI surface (`mint-token`, `revoke-user <username>`, `revoke-token <id>` — and nothing else; do not invent flags). Its `USAGE` string is the source of truth for command names/args.
- `SPEC.md` §5 (deliverables), §6 (auth/mint/register/login/revoke), §8 (data model — what `/data` holds), §11 (voice/ICE), §12 (security & deployment, env vars). Cross-link these section numbers in the docs as the contracts instruct.

## Existing Patterns

**Doc style (from `docs/DEVELOPMENT.md`):** single `#` H1, terse intro line, `## H2` sections, one-command-per-line fenced `bash` blocks with inline `# why` comments, and `>` blockquotes for warnings. README currently uses `## High Level` / `## Features` H2s — keep those, add runbook H2s below.

**Canonical literals the docs MUST cite verbatim (from the four contracts — do not re-derive):**

- Repo owner / namespace: `tdmiller1` (verified `git remote`: `git@github.com:tdmiller1/discord-clone.git`).
- Current version: `0.2.0` (root `package.json .version`; first release tag `v0.2.0`). No git tags exist yet.
- Server image (story 002): `ghcr.io/tdmiller1/discord-clone-server:<version>` and `:latest`. amd64/glibc only — NOT arm64, NOT musl/alpine (mediasoup glibc worker + `better-sqlite3` native build). `EXPOSE 8080`, `VOLUME /data`, `HEALTHCHECK` on `/health`.
- GHCR private-on-first-publish (story 002): either make the package Public (Profile → Packages → `discord-clone-server` → Package settings → Danger Zone → Change visibility → Public), or `echo "<PAT-with-read:packages>" | docker login ghcr.io -u tdmiller1 --password-stdin`.
- GitHub Release (story 003): tag/name `v<version>`; URL `https://github.com/tdmiller1/discord-clone/releases/tag/v<version>`; latest shortcut `.../releases/latest`; per-asset deep-link `.../releases/download/v<version>/<asset-filename>`.
- The exactly-four installer asset filenames (story 003), with install action:
  - `discord-clone_<version>_x64_en-US.msi` — Windows MSI, double-click.
  - `discord-clone_<version>_x64-setup.exe` — Windows NSIS, double-click.
  - `discord-clone_<version>_amd64.AppImage` — Linux portable, `chmod +x` then run.
  - `discord-clone_<version>_amd64.deb` — Debian, `sudo apt install ./<file>.deb`.
  - Concrete `v0.2.0` examples: `discord-clone_0.2.0_x64_en-US.msi`, etc. amd64/x64 only; no macOS; **unsigned** (Windows SmartScreen "Windows protected your PC" + Linux "untrusted AppImage" prompts are expected and must be click-through-allowed).
- Prod deploy (story 004): bundle under `deploy/` (`docker-compose.yml`, `.env.example`, `Caddyfile`); services `server` (image-pulled, `8080` internal-only, UDP `40000-40010` published) + `caddy:2` (80/443, reverse-proxies `server:8080`, auto Let's Encrypt). Required env `PUBLIC_HOST` + `CADDY_SITE` (both `${VAR:?}` fail-fast); optional `SERVER_IMAGE_TAG` (default `latest`, pin `0.2.0`), `CADDY_ACME_EMAIL`. One-command bring-up:
  ```sh
  cd deploy
  cp .env.example .env
  $EDITOR .env            # set PUBLIC_HOST, CADDY_SITE (+ SERVER_IMAGE_TAG, CADDY_ACME_EMAIL)
  # if the GHCR package is private: docker login ghcr.io -u tdmiller1
  docker compose up -d
  ```
  Verify: `curl -sf https://<CADDY_SITE>/health`, then connect a client to `wss://<CADDY_SITE>/ws`.

## Data Flow

The operator + end-user end-to-end journey, each leg mapped to its authoritative contract:

1. **Admin deploys the server** — `cd deploy && cp .env.example .env`, set `PUBLIC_HOST` + `CADDY_SITE` (+ pin `SERVER_IMAGE_TAG=0.2.0`), optional GHCR `docker login`, `docker compose up -d`. Pulls `ghcr.io/tdmiller1/discord-clone-server:<tag>`. → **story-004 deploy-compose.md** (bring-up) + **story-002 server-image.md** (image name/tags/arch/GHCR visibility).
2. **TLS / HTTPS+WSS comes up** — Caddy auto-issues a Let's Encrypt cert for `CADDY_SITE` (DNS A/AAAA must already resolve to the host) and reverse-proxies `server:8080`, forwarding the WS `Upgrade` automatically. → **story-004 deploy-compose.md** (TLS/WSS topology + Caddyfile shape).
3. **Admin mints an invite token** — `docker exec <ctr> server mint-token` prints a one-time token; revoke via `revoke-user`/`revoke-token`. (See Decision 4 + Open Question — the `server` bin invocation needs verification.) → **`server/src/cli.ts`** + **SPEC.md §6/§12**.
4. **Users download + install the client** — from `https://github.com/tdmiller1/discord-clone/releases/tag/v<version>`, pick the per-OS asset by exact filename, install (expect unsigned-binary warnings, click through). → **story-003 release-assets.md** (Release URL, asset filenames, unsigned-warning note).
5. **Register → login → connect** — first launch: enter server URL (`https://<CADDY_SITE>`), invite token, username, password → `POST /api/register` consumes the token → session → thereafter `POST /api/login`. Client derives `wss://` from the `https://` URL automatically. → **SPEC.md §6** + verified in `client/src/lib/gateway.svelte.ts:70` and `Login.svelte`/`Register.svelte`.
6. **Confirm text + inline images + voice** — create/use a text channel, send a message, upload an image (inline), join the one voice channel and hear another client. Voice media is raw DTLS-SRTP UDP `40000-40010` direct to `PUBLIC_HOST` — bypasses Caddy, needs host firewall + router UDP forward; `PUBLIC_HOST` must be the real routable host (never `localhost`) or voice silently fails while text/health look fine. → **SPEC.md §9/§10/§11** + **story-004 deploy-compose.md** (media topology).

## Decisions Made

1. **New ops doc named `docs/DEPLOYMENT.md`** (not `OPERATIONS.md`). The feature spec explicitly says "backed by a `docs/DEPLOYMENT.md` operations reference," and the AC offers it as the first option. Use that name for consistency with the spec.
2. **README stays the runbook; DEPLOYMENT.md is the reference.** Per the AC split: README = ordered, do-this-then-that admin walkthrough (the happy path) with the production gotchas inline; DEPLOYMENT.md = the lookup reference (env-var table, backup/restore, user/token management, arch, ICE troubleshooting). README links to DEPLOYMENT.md for depth. This avoids duplicating the env table in two places.
3. **Cite contract values verbatim, never re-derive.** Image name `ghcr.io/tdmiller1/discord-clone-server`, owner `tdmiller1`, asset filenames, Release URLs, env vars, the `40000-40010/udp` range, and the `cd deploy && … && docker compose up -d` flow all come straight from the four contracts and the on-disk `deploy/` files. Use `<version>`/`v<version>` placeholders with a `0.2.0` worked example, matching the contracts' own style.
4. **Document the token-mint command exactly as the contracts/AC state it (`docker exec <ctr> server mint-token`), but verify the exact invocation during plan/implement.** The image's package bin is `server` → `dist/cli.js` (`server/package.json`), but the runtime image's `CMD` is `node dist/index.js` and the node base-image `PATH` is `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` — it does **not** include `/app/node_modules/.bin`, and a package's own bin is not self-linked there anyway. So `docker exec <ctr> server mint-token` as literally written may resolve to "server: not found." The robust, always-works form is `docker exec <ctr> node dist/cli.js mint-token` (same for `revoke-user`/`revoke-token`). Since the AC demands "runnable as written," the runbook should use a form proven to work in the published image; the plan/implement phase must actually run it against the image and document whichever form succeeds. (See Open Questions.)
5. **Dev-vs-prod disambiguation is explicit.** README links contributors to `docs/DEVELOPMENT.md` + root `docker-compose.yml` (builds from source, `PUBLIC_HOST: localhost`, dev `cloudflared`/`web`) and admins to `deploy/docker-compose.yml` (pulls the image + Caddy TLS). Both compose files' header comments already state this; the docs mirror it.
6. **Caddy is the primary documented TLS path; "bring your own proxy" (incl. the existing Cloudflare tunnel) is a noted escape hatch.** Matches story-004's contract: any external TLS proxy is fine as long as it forwards the WS `Upgrade` on the same origin and the UDP media range still reaches the container directly (the tunnel never carries UDP — a direct router forward is still required).
7. **End-to-end verification is the milestone gate (SPEC §14), done in implement/validate, not research.** This research records the journey + the contracts; the author walks the deploy on a clean host (or faithful local stand-in: Caddy internal CA / test resolver for the cert + WS-accept check) and records the run + outcome in DONE notes.

## Open Questions

1. **`server mint-token` invocation in the published image.** The contracts and AC write the mint step as `docker exec <ctr> server mint-token`, but the image does not put the `server` bin on `PATH` (base-image `PATH` excludes `/app/node_modules/.bin`, and the root package's own bin isn't self-linked there). The reliable form is `docker exec <ctr> node dist/cli.js mint-token`. This is not a blocker for research, but the plan/implement phase **must** run the command against the actual published (or locally built) image and document the form that works, since AC line 2 requires every command be "runnable as written." Resolvable empirically during implement; no upstream decision needed.

2. **SPEC §12 "First boot generates an admin bootstrap credential printed to logs" is not implemented.** AC step 3 says the runbook should have the admin "find the first-boot admin bootstrap credential in the logs (`SPEC.md §12`)," but a full search of `server/src/` finds **no** bootstrap-admin user creation or credential logging (no `bootstrap`/`admin`/`is_admin`/`role` anywhere; `index.ts` only logs the listen address). The actual onboarding model (SPEC §6, `cli.ts`) is purely token-based: admin runs `mint-token`, the *user* registers the first account — there is no separate admin account or logged credential. The runbook should document the real flow (mint-token → register) and **not** instruct the operator to look for a non-existent log line. The plan should treat the AC's "bootstrap credential in logs" clause as describing an unimplemented SPEC aspiration and document reality instead (or flag the SPEC/AC mismatch for the user). This is the one item worth surfacing to the user before writing prose, but it does not block the plan — the correct, runnable behavior is unambiguous from `cli.ts` + SPEC §6.
