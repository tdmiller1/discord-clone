#plan

# Plan: Verified README deploy runbook + operations docs

## Summary
Expand the root `README.md` from its ~20-line stub into an ordered admin deploy runbook (prod compose → Caddy TLS → mint invite token → download/install client from the GitHub Release → register/login → confirm text + images + voice), and add a `docs/DEPLOYMENT.md` operations reference (env-var table, `/data` backup/restore, user/token management, supported arch, voice/ICE troubleshooting), plus a small dev↔prod cross-link and CI-accuracy touch-up in `docs/DEVELOPMENT.md`. Docs-only; all commands and literals are cited verbatim from the four upstream contracts and the on-disk `deploy/` files, with the token-mint command corrected to the empirically verified runnable form (`docker exec <ctr> node dist/cli.js mint-token`).

### Resolution of the two research open questions (final)
- **OQ1 — mint-token invocation.** Verified empirically against the local image (built from the same `server/Dockerfile`): `docker exec <ctr> server mint-token` **fails** with `Error: Cannot find module '/app/server'` (the package's `server` bin is not on the runtime image PATH = `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, and `node` treats the bare `server` arg as a missing script). The form that **works** (exit 0, prints a raw token) is `docker exec <ctr> node dist/cli.js mint-token`, run from WORKDIR `/app` where `dist/cli.js` lives. The runbook and ops doc use `node dist/cli.js <subcommand>` for all three CLI commands (`mint-token`, `revoke-user <username>`, `revoke-token <id>`) so every command is runnable as written (AC line 2). The cosmetic `Usage: server <command>` help string is noted but not used as an invocation.
- **OQ2 — "first-boot admin bootstrap credential in logs."** SPEC.md §12 (lines 177-178) literally claims first boot prints an admin bootstrap credential, but this is an unimplemented SPEC aspiration: `server/src/cli.ts` has only `mint-token`/`revoke-user`/`revoke-token`, there is no bootstrap-admin user creation or credential logging anywhere in `server/src/`, and SPEC §6 (the actual auth flow) is purely token-based (admin mints invite token → first user registers; no separate admin account). The docs document the **real** flow (mint a token → first user registers the first account) and do **not** instruct the operator to look for a non-existent log line. A one-line note flags the §12/§6 mismatch as a doc-vs-reality discrepancy so it isn't mistaken for a missing step.

## Implementation Steps

### Step 1: Expand `README.md` into the deploy runbook (keep the existing intro)
**File(s):** `README.md`
**Action:** modify
**Description:** Keep the existing `# discord-clone`, `## High Level`, and `## Features` sections (the high-level intro). Append a deploy runbook below them, mirroring the repo doc style from `docs/DEVELOPMENT.md` (single H1 already present; `## H2` sections; one-command-per-line fenced ```bash blocks with trailing `# why` comments; `>` blockquote callouts for gotchas). New H2 sections to add, in order:

- `## Deploy (admin runbook)` — short lead-in stating this stands up a public HTTPS/WSS server with voice using the **published image** + Caddy, and that contributors building from source should see `docs/DEVELOPMENT.md` instead (dev↔prod disambiguation, AC line 5).
  - **Prerequisites** subsection (prose/bullets): a host with Docker + Compose; a domain whose DNS A/AAAA already resolves to the host (for Let's Encrypt); the UDP media range `40000-40010/udp` allowed in the host firewall and router-forwarded to the host; amd64/glibc host (the image is amd64/glibc only — see arch gotcha). Cite verbatim: image is `linux/amd64, glibc` ONLY (NOT arm64, NOT musl/alpine).
  - **1. Deploy the server (prod compose, pulls the published image)** — the verbatim story-004 one-command bring-up, run from `deploy/`:
    ```sh
    cd deploy
    cp .env.example .env
    $EDITOR .env            # set PUBLIC_HOST, CADDY_SITE (+ SERVER_IMAGE_TAG, CADDY_ACME_EMAIL)
    # if the GHCR package is private: docker login ghcr.io -u tdmiller1
    docker compose up -d
    ```
    Name the required env vars to set in `deploy/.env`: `PUBLIC_HOST` (real routable host, **never `localhost`**), `CADDY_SITE` (public domain, DNS must resolve here); recommend pinning `SERVER_IMAGE_TAG=0.2.0` rather than `latest`; optional `CADDY_ACME_EMAIL`. State the image pulled: `ghcr.io/tdmiller1/discord-clone-server:${SERVER_IMAGE_TAG:-latest}` (verbatim). Cross-link `docs/DEPLOYMENT.md` for the full env table. Include the GHCR-private path verbatim (story 002):
    ```sh
    echo "<PAT-with-read:packages>" | docker login ghcr.io -u tdmiller1 --password-stdin
    ```
    and the alternative (make the package Public: Profile → Packages → `discord-clone-server` → Package settings → Danger Zone → Change visibility → Public).
  - **2. Confirm HTTPS/WSS (Caddy auto-TLS)** — Caddy auto-issues a Let's Encrypt cert for `CADDY_SITE` and reverse-proxies `server:8080`, forwarding the WebSocket `Upgrade` automatically. Verify (verbatim, with `<CADDY_SITE>` substitution):
    ```sh
    curl -sf https://<CADDY_SITE>/health     # 200 over the proxy, real cert
    ```
    Note that HTTPS/WSS is **required** (SPEC §12); a no-TLS `ws://`/`http://` setup breaks the client. Mention the "bring your own proxy" escape hatch (any external TLS proxy / the existing Cloudflare tunnel) as long as it forwards the WS `Upgrade` on the same origin AND the UDP media range still reaches the container directly (the tunnel never carries UDP).
  - **3. Mint an invite token (real CLI)** — onboarding is purely token-based (SPEC §6). Find the running container name (`docker compose ps`), then mint (verified runnable form):
    ```sh
    docker compose exec server node dist/cli.js mint-token   # prints a one-time token
    ```
    (or `docker exec <ctr> node dist/cli.js mint-token`). State the token is single-use and printed once; copy it. Add a `>` note: SPEC §12 mentions a "first-boot admin bootstrap credential printed to logs," but the implemented flow has **no** such log line and no separate admin account — the **first user to register** with a minted token creates the first account. Point to `docs/DEPLOYMENT.md` for `revoke-user`/`revoke-token`.
  - **4. Download + install the client (GitHub Release)** — link the Release page verbatim: `https://github.com/tdmiller1/discord-clone/releases/tag/v<version>` (e.g. `.../releases/tag/v0.2.0`) and the latest shortcut `https://github.com/tdmiller1/discord-clone/releases/latest`. A per-OS table citing the exactly-four asset filenames + install action verbatim (story 003):
    - Windows MSI: `discord-clone_<version>_x64_en-US.msi` — double-click to install.
    - Windows NSIS: `discord-clone_<version>_x64-setup.exe` — double-click to install.
    - Linux AppImage: `discord-clone_<version>_amd64.AppImage` — `chmod +x` then run.
    - Linux Debian: `discord-clone_<version>_amd64.deb` — `sudo apt install ./<file>.deb`.
    Worked `0.2.0` examples (`discord-clone_0.2.0_x64_en-US.msi`, etc.). Note amd64/x64 only, no macOS. A `>` callout: installers are **unsigned** — expect Windows SmartScreen ("Windows protected your PC") and Linux "untrusted AppImage" prompts; these are normal and must be explicitly allowed (More info → Run anyway).
  - **5. Register → login → connect** — first launch: enter server URL `https://<CADDY_SITE>`, paste the invite token, choose username + password → registers (consumes the token) → session. Thereafter login with username + password. The client derives `wss://<CADDY_SITE>/ws` from the `https://` URL automatically (verified in `client/src/lib/gateway.svelte.ts` `wsUrl()`); the operator does not enter a separate WS URL.
  - **6. Confirm it works end-to-end** — create/use a text channel and send a message (text); upload an image and see it render inline (images); join the single voice channel from a second client and confirm two-way audio (voice). A `>` gotcha callout: if text/images/`/health` work but **voice is silent**, the cause is almost always `PUBLIC_HOST` set to `localhost`/an unroutable value, or the UDP `40000-40010` range not firewall-open / router-forwarded to the host — voice media is raw DTLS-SRTP UDP direct to `PUBLIC_HOST`, bypassing Caddy. Cross-link `docs/DEPLOYMENT.md` voice/ICE troubleshooting.
- `## Dev vs prod` (or fold into the runbook lead-in) — explicit one-paragraph disambiguation (AC line 5): contributors building from source use the **root `docker-compose.yml`** (`build: ./server`, `PUBLIC_HOST: localhost`, no TLS) + `docs/DEVELOPMENT.md`; admins deploying the published image use **`deploy/docker-compose.yml`** (pulls GHCR image + Caddy TLS) per this runbook. Both compose files' header comments already state this.

**Diff shape:**
- Add: `## Deploy (admin runbook)` with the 6 ordered steps, prerequisites, the four production gotcha callouts (PUBLIC_HOST≠localhost, UDP range firewall/forward, unsigned-binary warnings, HTTPS/WSS required), and a dev-vs-prod disambiguation paragraph; a link to `docs/DEPLOYMENT.md`.
- Remove: nothing (existing intro/Features kept).
- Change: nothing in the existing top sections beyond optionally adding the dev/prod link.

### Step 2: Create `docs/DEPLOYMENT.md` operations reference
**File(s):** `docs/DEPLOYMENT.md`
**Action:** create
**Description:** The lookup reference required by AC line 4 (research Decision 1: name it `docs/DEPLOYMENT.md`, matching the feature spec). Same doc style as `docs/DEVELOPMENT.md`. Sections:

- Short H1 + lead-in: "Operations reference for a deployed discord-clone server. For the step-by-step bring-up see the README runbook; for building from source see `docs/DEVELOPMENT.md`." (Reinforces the dev↔prod boundary.)
- `## Environment variables` — a table cross-linking `SPEC.md §12`, `server/.env.example`, and `deploy/.env.example`. Cite verbatim defaults from the deploy contract / `server/.env.example`:
  - Required (compose `${VAR:?}` fail-fast): `PUBLIC_HOST` (real routable IPv4/hostname, ICE announce address §11, **never `localhost`**), `CADDY_SITE` (public domain, DNS must resolve).
  - Optional deploy: `SERVER_IMAGE_TAG` (default `latest`; pin `0.2.0` in prod), `CADDY_ACME_EMAIL` (default empty).
  - Optional server tuning: `RTC_EXTRA_ANNOUNCED_IPS` (empty), `MAX_UPLOAD_MB=10`, `SESSION_TTL=604800`, `AUTH_RATE_MAX=10`, `AUTH_RATE_WINDOW_MS=60000`. Also list `MAX_MESSAGE_LENGTH=4000`, `MSG_HISTORY_DEFAULT_LIMIT=50`, `MSG_HISTORY_MAX_LIMIT=100` from `server/.env.example`.
  - Fixed-in-compose literals: `RTC_MIN_PORT=40000`, `RTC_MAX_PORT=40010`, `DATA_DIR=/data`, `NODE_ENV=production`, `HTTP_PORT=8080`. Note `RTC_MIN_PORT`/`RTC_MAX_PORT` MUST equal the compose UDP `40000-40010` mapping (CLAUDE.md hard rule).
- `## Supported image architecture` — `linux/amd64, glibc (Debian bookworm) ONLY` verbatim; NOT arm64, NOT musl/alpine (mediasoup glibc worker §11 + `better-sqlite3` native build). Pulling on arm64 will not run. Tags: `ghcr.io/tdmiller1/discord-clone-server:<version>` (pin in prod) and `:latest` (convenience).
- `## Backup & restore (/data)` — the named volume `discord-data` mounts at `/data` and holds the SQLite DB + uploaded image files (SPEC §8); **nothing voice-related is persisted** (voice is ephemeral SFU state). Give a safe backup approach (the DB is the source of truth for users/sessions/messages; images are files under `/data/images/<id>`). Backup example using a throwaway container to tar `/data` from the named volume; restore example by extracting into a fresh volume; note stopping the server (or quiescing) for a consistent SQLite snapshot. Use only documented Docker/volume mechanics — no app-specific dump command (none exists).
- `## User & token management` — the real CLI (`server/src/cli.ts`), runnable form (verified):
  ```sh
  docker compose exec server node dist/cli.js mint-token              # single-use invite token
  docker compose exec server node dist/cli.js revoke-user <username>  # disable account + kill its sessions
  docker compose exec server node dist/cli.js revoke-token <id>       # revoke an unused invite token by id
  ```
  Describe each from `cli.ts` behavior: `mint-token` prints the raw token once (stored hashed, single-use); `revoke-user` sets `disabled=1` and revokes all that user's sessions; `revoke-token` revokes an unused token by numeric id. Do **not** invent flags. Add the §12-vs-reality note: there is no admin-bootstrap credential / log line; onboarding is mint-token → user registers.
- `## Voice / ICE troubleshooting` — symptom-driven (text/images/`/health` fine but voice silent): (1) `PUBLIC_HOST` must be the real routable host, never `localhost`, or ICE announces an unreachable candidate (`announcedIp`, §11); set `RTC_EXTRA_ANNOUNCED_IPS` for a LAN IP if on-LAN clients need a direct candidate (each extra IP consumes one more UDP port/transport). (2) The UDP media range `40000-40010` must be host-firewall-allowed and router UDP-forwarded directly to the host — it is raw DTLS-SRTP and bypasses Caddy. (3) WSS-upgrade-through-proxy: the gateway + voice signaling ride `wss://<CADDY_SITE>/ws`; Caddy's `reverse_proxy` forwards the `Upgrade`/`Connection` headers automatically, but a custom/misconfigured proxy that drops them breaks the WS gateway even though `/health` looks fine.
- `## TLS options` (brief) — Caddy is the primary documented path (auto Let's Encrypt for `CADDY_SITE`). Escape hatch: any external TLS proxy / the existing Cloudflare tunnel is fine if it forwards the WS `Upgrade` on the same origin and the UDP media range still reaches the container directly (the tunnel never carries UDP — a direct router forward is still required).

**Diff shape:**
- Add: a new `docs/DEPLOYMENT.md` with the sections above.
- Remove: nothing.
- Change: nothing.

### Step 3: Add dev↔prod cross-link + CI-accuracy touch-up in `docs/DEVELOPMENT.md`
**File(s):** `docs/DEVELOPMENT.md`
**Action:** modify
**Description:** Two small edits (research "Likely Modified"):
1. Add a one-line cross-link near the top (after the monorepo-layout block or under a heading) pointing admins/deployers to the README runbook + `docs/DEPLOYMENT.md`, so the dev↔prod boundary is symmetric (this doc = build/dev from source; runbook/ops doc = deploy the published image).
2. Touch up the stale `## CI` bullet: it currently says client installers upload "as artifacts." Story 003 makes a `v*` tag attach `.msi`/`.exe`/`.AppImage`/`.deb` to a **GitHub Release** (per-change PR/push runs still build them as the gate). Reword so the per-change gate vs the tag-triggered Release is accurate, without over-detailing (story 002/003 own the CI specifics).

**Diff shape:**
- Add: one cross-link line to the README runbook + `docs/DEPLOYMENT.md`.
- Remove: the "uploading ... installers as artifacts" phrasing implying ephemeral artifacts are the distribution surface.
- Change: the `## CI` client bullet to note tag-triggered Release attachment (story 003) as the published distribution path.

## New Types / Schemas / Contracts
None — documentation only. This story `provides_contract:` is empty in its frontmatter; it consumes the four upstream contracts and ships prose. No downstream story depends on an interface introduced here.

## Configuration / Environment Changes
This story introduces **no** new config — it documents existing config. The `docs/DEPLOYMENT.md` env table documents (verbatim, sourced from `deploy/.env.example` + `server/.env.example` + the deploy contract): required `PUBLIC_HOST`, `CADDY_SITE`; optional `SERVER_IMAGE_TAG` (default `latest`), `CADDY_ACME_EMAIL`, `RTC_EXTRA_ANNOUNCED_IPS`, `MAX_UPLOAD_MB=10`, `SESSION_TTL=604800`, `AUTH_RATE_MAX=10`, `AUTH_RATE_WINDOW_MS=60000`, `MAX_MESSAGE_LENGTH=4000`, `MSG_HISTORY_DEFAULT_LIMIT=50`, `MSG_HISTORY_MAX_LIMIT=100`; and the fixed-in-compose literals `RTC_MIN_PORT=40000`, `RTC_MAX_PORT=40010`, `DATA_DIR=/data`, `NODE_ENV=production`, `HTTP_PORT=8080`. Stale-reference reconciliation: Step 3 fixes `docs/DEVELOPMENT.md` calling release installers "artifacts" (they are now GitHub Release assets, story 003).

## API / Interface Changes
None (docs only). Doc-visible command surfaces being documented (existing, not new): the admin CLI in `server/src/cli.ts`, surfaced as the **verified runnable** invocation `docker [compose] exec server node dist/cli.js {mint-token | revoke-user <username> | revoke-token <id>}` — NOT `docker exec <ctr> server mint-token` (that form fails; see OQ1). Plus the documented endpoint surfaces clients use (`/health`, `POST /api/register`, `POST /api/login`, `wss://<host>/ws`) referenced only descriptively.

## Edge Cases & Gotchas
- **Mint-token invocation that actually runs** — `docker exec <ctr> server mint-token` fails (`Cannot find module '/app/server'`); the runnable form is `node dist/cli.js mint-token` from WORKDIR `/app`. Empirically verified (Step 1/OQ1); the runbook (Step 1.3) and ops doc (Step 2) use the working form.
- **Non-existent admin-bootstrap log line** — SPEC §12's "first-boot admin bootstrap credential printed to logs" is unimplemented; docs describe the real token-based onboarding and a `>` note flags the §12-vs-§6/code mismatch — handled in Step 1.3 and Step 2.
- **GHCR private-package pull auth** — image may be private on first publish; runbook gives both the `docker login ghcr.io -u tdmiller1 --password-stdin` PAT path and the make-it-Public path — handled in Step 1.1.
- **`PUBLIC_HOST` must be routable, never `localhost`** — voice silently fails (text/images/health still look fine) if ICE announces `localhost` — handled in Step 1.1, Step 1.6 callout, Step 2 voice/ICE.
- **UDP media range must be firewall-open + router-forwarded** — `40000-40010/udp` is raw DTLS-SRTP direct to the host, bypassing Caddy — handled in Step 1 prerequisites, Step 1.6 callout, Step 2.
- **Version pin vs `:latest`** — recommend pinning `SERVER_IMAGE_TAG=0.2.0`; `:latest` is convenience and moves on each release — handled in Step 1.1, Step 2 env table + arch section.
- **Unsigned-binary warnings** — Windows SmartScreen + Linux untrusted-AppImage prompts are expected and must be click-through-allowed — handled in Step 1.4 callout.
- **HTTPS/WSS required** — plain `ws://`/`http://` breaks the client; TLS via Caddy (or an escape-hatch proxy that forwards the WS `Upgrade`) is required (§12) — handled in Step 1.2, Step 2 TLS/voice sections.
- **WSS upgrade through the proxy** — a proxy dropping `Upgrade`/`Connection` breaks the gateway while `/health` still 200s — handled in Step 2 voice/ICE troubleshooting.
- **`/data` backup consistency** — SQLite DB + image files in the `discord-data` volume; nothing voice-related persisted (§8); document a consistent (quiesced) snapshot — handled in Step 2 backup/restore.
- **Image arch mismatch** — amd64/glibc only; an arm64 host can't run it — handled in Step 1 prerequisites + Step 2 arch section.
- **Dev vs prod compose confusion** — root `docker-compose.yml` (build from source, localhost, no TLS) vs `deploy/docker-compose.yml` (pull image + Caddy TLS) — handled in Step 1 dev-vs-prod paragraph + Step 3 cross-link.
- **Verification gate (SPEC §14 / AC line 6)** — implement/validate must actually walk the runbook on a clean host or a faithful local stand-in (Caddy internal CA / test resolver for the cert + a WS-accept check; mint-token already proven against the image) and record the run + outcome in DONE notes. This is the milestone acceptance, not a unit test.
- **typecheck stays green (AC line 7)** — docs-only, no TS touched; `npm run typecheck` passes trivially.

## Acceptance Criteria Checklist
- [ ] README expanded into an ordered deploy runbook (prod compose → HTTPS/WSS → mint token → download/install client → register/login → confirm text/images/voice) → Step 1 (with §12-vs-reality note replacing the non-existent "bootstrap credential in logs")
- [ ] Every command runnable as written (correct `ghcr.io/tdmiller1/...` path, correct asset filenames, correct env vars, **verified** `node dist/cli.js` mint form) → Step 1, Step 2 (verbatim from contracts; OQ1 verified)
- [ ] Production gotchas called out: real `PUBLIC_HOST` (voice fails on localhost), open UDP media range, unsigned-binary warnings, HTTPS/WSS required → Step 1 (callouts) + Step 2
- [ ] Ops doc covers env-var reference, `/data` backup & restore, user/token management (`revoke-user`/`revoke-token`), supported arch (amd64/glibc), voice/ICE troubleshooting → Step 2
- [ ] Dev vs prod unambiguous (contributors → `docs/DEVELOPMENT.md` + root dev compose; admins → prod compose) → Step 1 (dev-vs-prod paragraph) + Step 3 (cross-link)
- [ ] Verified end-to-end (SPEC §14); DONE notes record what was run + outcome → executed in implement/validate (mint-token already proven; bring-up + client connect to be walked)
- [ ] `npm run typecheck` still passes → no TS touched (Steps 1–3 are Markdown only)
