#research

# Research: Tag-triggered — build & push the server image to GHCR

## Files to Touch

### Likely Modified
- `.github/workflows/ci.yml` — add a new tag-gated job (e.g. `release-server-image`) that logs into GHCR, builds the existing `server/Dockerfile`, and pushes `ghcr.io/tdmiller1/discord-clone-server` tagged `<version>` + `latest`. Story 001 already added the `tags: ['v*']` trigger (lines 4–6) and the `release-version-guard` job; this story extends the same file with the publish job.

### Likely Created
- `context/features/m5-release-docs/story-002-release-server-image/contracts/server-image.md` — the contract this story `provides_contract` (frontmatter). Records the full registry path, tag scheme (`<version>` + `latest`), supported arch (amd64/glibc), and package-visibility notes for stories 004/005. The `contracts/` subdir does not exist yet (only the `_story.md` is present); mirror story 001's `contracts/` layout.

### Read-Only Reference (patterns to follow)
- `.github/workflows/ci.yml` — the existing `server` job (lines 31–54) already does `docker build -t discord-clone-server:ci .` from `working-directory: server`; the `release-version-guard` job (lines 11–28) is the template for a tag-gated job (`if: startsWith(github.ref, 'refs/tags/v')` + `VERSION="${GITHUB_REF_NAME#v}"`). Copy both shapes.
- `server/Dockerfile` — the multi-stage glibc build to reuse verbatim (build context `server/`, default target = `runtime` stage). Do NOT author a second Dockerfile (AC + feature constraint).
- `context/features/m5-release-docs/story-001-release-versioning/contracts/versioning.md` — UPSTREAM CONTRACT. Image tags MUST derive from `<version> = ${GITHUB_REF_NAME#v}`; the contract already fixes the names `ghcr.io/tdmiller1/discord-clone-server:<version>` and `:latest` (lines 112, 116). Conform exactly.
- `context/features/m5-release-docs/story-001-release-versioning/{research.md,plan.md,DONE}` — example of the per-story doc/contract structure and the established CI conventions (Node 24, `actions/checkout@v4`, `actions/setup-node@v4`).
- `docker-compose.yml` — current dev compose uses `image: discord-clone-server:dev` + `build: ./server`; the prod compose (story 004) will consume the GHCR name this story publishes. Read-only context for the contract's downstream notes.

## Existing Patterns

**CI workflow structure (`.github/workflows/ci.yml`).** Single workflow `CI`, four jobs today: `release-version-guard` (tag-only), `server`, `client`, all `runs-on: ubuntu-latest` (client is a windows+ubuntu matrix). Conventions in force:
- Triggers (post-story-001): `push` on `branches: [main]` + `tags: ['v*']`, plus `pull_request` and `workflow_dispatch`.
- Tag-gating is done at the job level with `if: startsWith(github.ref, 'refs/tags/v')` so the job is a no-op on branch/PR/dispatch runs — exactly how `release-version-guard` is scoped. The per-change `server`/`client` gate jobs have no `if:` and keep running on every push/PR.
- Version derivation is the shell expansion `VERSION="${GITHUB_REF_NAME#v}"` inside a `run:` step (guard job, line 22). This is the canonical rule from `versioning.md` and is the same expression the new image job must use to name the version tag.
- Standard step stack: `actions/checkout@v4`, `actions/setup-node@v4` with `node-version: 24`. No third-party docker actions are used yet (the existing `server` job calls `docker build` directly via the runner's preinstalled Docker).
- The `server` job sets `defaults.run.working-directory: server` and builds with context `.` (i.e. `server/`). The new publish job needs the same context so `server/Dockerfile` + `server/.dockerignore` apply.

**Dockerfile (`server/Dockerfile`).** Multi-stage: `build` (node:24-bookworm-slim + python3/make/g++ for `better-sqlite3` and the mediasoup worker fallback) → `runtime` (node:24-bookworm-slim, `USER node`, `VOLUME /data`, `EXPOSE 8080`, `HEALTHCHECK` hitting `/health`, `CMD ["node","dist/index.js"]`). It is glibc/amd64 by construction (bookworm, NOT alpine) — the AC's "preserve glibc/amd64" is satisfied simply by building on the ubuntu-latest (amd64) runner with the default platform; no `--platform`/buildx multi-arch is needed or wanted (multi-arch is an explicit non-goal). `server/.dockerignore` excludes `node_modules`, `dist`, `data`, `.env*`, `*.log`.

**Auth pattern for GHCR.** No existing reference in-repo (no current registry push), but the established GitHub-native approach: grant the job `permissions: packages: write` (and `contents: read`), then `docker login ghcr.io` with `${{ github.actor }}` / `${{ secrets.GITHUB_TOKEN }}` — no manual PAT/registry secret. AC explicitly requires this (workflow `GITHUB_TOKEN` + `permissions: packages: write`). Two viable styles, both consistent with the repo:
- Plain `docker login` + `docker build` + `docker push` (matches the existing direct-`docker` style of the `server` job, zero new action deps).
- Or `docker/login-action` + `docker/build-push-action` (more standard, but introduces third-party actions not yet used here).
Either satisfies the AC; the plan should pick one (see Decisions).

**Story/contract doc layout.** Story 001 established the per-story `contracts/<name>.md` pattern (a markdown file starting with `#contract`, an authoritative-statement header, then sections). Story 002's `provides_contract: contracts/server-image.md` must follow the same shape.

## Data Flow

Release publish path (additive to the existing per-change CI):

1. Maintainer reconciles `package.json` `.version` (story 001 keeps every literal at `0.2.0`) and pushes a git tag `v<version>` (e.g. `v0.2.0`).
2. The tag push fires `ci.yml`. Tag-gated jobs run: `release-version-guard` derives `VERSION="${GITHUB_REF_NAME#v}"`, compares against `node -p require('./package.json').version`, and `exit 1`s on mismatch (story 001). The per-change `server`/`client` jobs also run on the tag ref but are unchanged.
3. The new `release-server-image` job (this story): checks out the repo, derives `VERSION="${GITHUB_REF_NAME#v}"`, logs into `ghcr.io` with `GITHUB_TOKEN`, builds `server/Dockerfile` (context `server/`, default `runtime` target, amd64/glibc on the ubuntu runner), and pushes two tags: `ghcr.io/tdmiller1/discord-clone-server:<version>` and `ghcr.io/tdmiller1/discord-clone-server:latest`.
4. Re-running the workflow / re-pushing the tag overwrites the `<version>` and `latest` tags in GHCR (registry push is overwrite-by-tag) — idempotent, no "already exists" failure.
5. Downstream: an admin (story 004 prod compose / story 005 docs) does `docker pull ghcr.io/tdmiller1/discord-clone-server:<version>` and `docker run`; `/health` serves (verified by the AC's acceptance-verification step and the image's own HEALTHCHECK).

Owner resolution: `git remote` → `git@github.com:tdmiller1/discord-clone.git`, so `<owner> = tdmiller1`. It is already all-lowercase, so the GHCR lowercase-path requirement is satisfied with a hardcoded literal; no `tr` lowercasing needed. The `versioning.md` contract already commits to this exact registry path.

## Decisions Made

1. **Extend `ci.yml` with a new job rather than add a separate `release.yml`.** The AC permits either, but story 001 already put the `v*` trigger and `release-version-guard` in `ci.yml`, and keeping all release jobs in one workflow lets the image job optionally `needs: release-version-guard` so a version-mismatched tag never publishes. This matches the precedent the feature has already set.

2. **Tag-gate the job with `if: startsWith(github.ref, 'refs/tags/v')` and derive the version with `VERSION="${GITHUB_REF_NAME#v}"`.** Identical to the guard job — keeps the release path additive (no-op on branch/PR/dispatch) and uses the canonical derivation from `versioning.md`. Existing `server`/`client` gate jobs stay untouched.

3. **Build on `ubuntu-latest` with the default platform (no `--platform`/buildx/multi-arch).** The runner is amd64 and `server/Dockerfile` is glibc (bookworm) by construction, so a plain build yields the required amd64/glibc image. Multi-arch is an explicit feature non-goal; adding buildx would be gold-plating.

4. **Reuse `server/Dockerfile` with build context `server/`** (`docker build server/` or `working-directory: server` + `docker build .`). No second Dockerfile — AC and feature constraint. `server/.dockerignore` already trims the context.

5. **Hardcode the registry path `ghcr.io/tdmiller1/discord-clone-server`** (owner already lowercase) and push both `:<version>` and `:latest`. The `versioning.md` contract fixes these names; the plan may instead template the owner via `${{ github.repository_owner }}` piped through lowercasing, but a literal is simpler and matches the contract's committed string. Plan to call this out.

6. **Auth via `docker login ghcr.io -u ${{ github.actor }} -p ${{ secrets.GITHUB_TOKEN }}` with job `permissions: { packages: write, contents: read }`.** No new registry secret; matches the AC. The plan picks between plain `docker` CLI (consistent with the existing `server` job's direct `docker build`, no new action deps) vs `docker/login-action` + `docker/build-push-action` (more idiomatic). Leaning plain-`docker` to avoid introducing third-party actions the repo doesn't already use, but this is a plan-phase call.

7. **`contracts/server-image.md` is the deliverable contract** and must record: full path `ghcr.io/tdmiller1/discord-clone-server`, tag scheme `<version>` + `latest`, arch `amd64/glibc only`, and GHCR package-visibility notes (first publish defaults to private; how to make it public/pullable — for stories 004/005). Create the `contracts/` subdir (does not exist yet).

8. **Package visibility is a documentation concern, not a build step.** GHCR packages default to private on first publish; the workflow cannot reliably flip visibility (the `GITHUB_TOKEN` can push but org/user package visibility is a settings action). The contract documents the manual "Package settings → change visibility to Public" step (and/or that the deploy host must `docker login` if kept private) for stories 004/005 to surface in the runbook. No AC requires the workflow itself to make it public.
