#plan

# Plan: Tag-triggered — build & push the server image to GHCR

## Summary
Add one **additive, tag-gated** job to `.github/workflows/ci.yml` (`release-server-image`) that, on a `v*` tag push, derives `VERSION="${GITHUB_REF_NAME#v}"`, logs into GHCR with the workflow `GITHUB_TOKEN`, builds the existing multi-stage `server/Dockerfile` (context `server/`, amd64/glibc on the ubuntu runner), and pushes `ghcr.io/tdmiller1/discord-clone-server:<version>` + `:latest`; then record the published image reference in the `contracts/server-image.md` contract for downstream stories 004/005.

All eight research "Decisions Made" are treated as final and adopted: (1) extend `ci.yml` not a separate `release.yml`; (2) tag-gate with `if: startsWith(github.ref, 'refs/tags/v')` + `${GITHUB_REF_NAME#v}`; (3) plain `ubuntu-latest` default-platform build (no buildx/multi-arch); (4) reuse `server/Dockerfile` with context `server/`; (5) hardcode the registry path literal `ghcr.io/tdmiller1/discord-clone-server`; (6) auth via `docker login ghcr.io -u ${{ github.actor }} --password-stdin` with job `permissions: { packages: write, contents: read }`; (7) `contracts/server-image.md` is the deliverable; (8) package visibility is a docs concern, not a build step.

Two judgment calls I am making explicit (not spelled out in the story): **(a)** the new job declares `needs: release-version-guard` so a version-mismatched tag (caught by story 001's guard) never publishes an image — this leverages the same-workflow precedent from Decision 1 and prevents shipping a wrongly-named image; it does **not** touch the guard job itself. **(b)** Auth uses `--password-stdin` (token piped via stdin) rather than `-p ${{ secrets.GITHUB_TOKEN }}` on the command line, to avoid leaking the token into the process table / job log while still being plain-`docker` (no third-party action), satisfying the AC's "authenticates with the workflow `GITHUB_TOKEN`" requirement.

## Implementation Steps

### Step 1: Add the `release-server-image` job to CI
**File(s):** `.github/workflows/ci.yml`
**Action:** modify
**Description:** Append a new job, **additive only** — the existing `release-version-guard`, `server`, and `client` jobs are untouched (no edits to their steps, triggers, or `if:`), and the workflow-level `on:` block is unchanged (story 001 already added `push.tags: ['v*']`). The new job is tag-gated so it is a no-op on branch/PR/`workflow_dispatch` runs, keeping the per-change CI gate intact and the release path additive. It declares the minimum permissions to push to GHCR, derives the version with the canonical rule from `versioning.md`, authenticates with the GitHub-native `GITHUB_TOKEN` (no manual registry secret), reuses `server/Dockerfile` from the `server/` build context, and pushes both the `<version>` and `latest` tags. Because registry push is overwrite-by-tag, re-running the workflow for an existing tag simply re-pushes (overwrites) those tags and does not fail — satisfying idempotency.
**Diff shape:**
- Add: a new top-level job under `jobs:` (after the existing `client` job), e.g.:
  ```yaml
    release-server-image:
      name: Release server image (push to GHCR)
      runs-on: ubuntu-latest
      if: startsWith(github.ref, 'refs/tags/v')
      needs: release-version-guard
      permissions:
        contents: read
        packages: write
      env:
        IMAGE: ghcr.io/tdmiller1/discord-clone-server
      steps:
        - uses: actions/checkout@v4
        - name: Derive version from tag
          run: echo "VERSION=${GITHUB_REF_NAME#v}" >> "$GITHUB_ENV"
        - name: Log in to GHCR
          run: echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u "${{ github.actor }}" --password-stdin
        - name: Build server image
          working-directory: server
          run: docker build -t "$IMAGE:$VERSION" -t "$IMAGE:latest" .
        - name: Push server image
          run: |
            docker push "$IMAGE:$VERSION"
            docker push "$IMAGE:latest"
  ```
- Remove: nothing.
- Change: nothing in the existing `on:` block or the `release-version-guard`/`server`/`client` jobs.

Notes binding this to the established patterns:
- `actions/checkout@v4` matches every existing job; no `setup-node` needed (the version is derived by shell expansion, not Node).
- `${GITHUB_REF_NAME#v}` is the **exact** derivation from `versioning.md` (the same expression the guard uses); writing it to `$GITHUB_ENV` makes `$VERSION` available to later steps.
- `working-directory: server` + `docker build … .` mirrors the existing `server` job's "Build Docker image" step (`docker build -t discord-clone-server:ci .` from `working-directory: server`), so `server/Dockerfile` and `server/.dockerignore` apply unchanged. Default target is the `runtime` stage; default platform on the amd64 runner yields the required amd64/glibc image with no `--platform`/buildx.
- `permissions:` is set **at the job level** (not workflow level) so the existing jobs keep their default token scope and only this job gains `packages: write`.
- `needs: release-version-guard` (judgment call a) chains this job after the guard; since both share the same `if: startsWith(github.ref, 'refs/tags/v')` tag gate they run together on `v*` tags, and a guard failure (version mismatch) skips the publish.

### Step 2: Create the `contracts/server-image.md` contract
**File(s):** `context/features/m5-release-docs/story-002-release-server-image/contracts/server-image.md`
**Action:** create
**Description:** Create the `contracts/` subdir (does not exist yet) and the `provides_contract` artifact this story owns. Mirror story 001's `versioning.md` shape: lead with `#contract`, a `# Contract:` title naming downstream consumers (stories 004 and 005), then concrete sections. It must authoritatively record: the full published image reference (`ghcr.io/tdmiller1/discord-clone-server`), the registry/namespace/name breakdown, the two tags pushed (`<version>` and `latest`), how `<version>` derives from the git tag (`${GITHUB_REF_NAME#v}`, inherited from `versioning.md`), the supported arch (`linux/amd64`, glibc only — mediasoup worker + `better-sqlite3` constraint, no arm64), the exact `docker pull` / `docker run` commands, GHCR package-visibility notes (first publish defaults to **private**; how to make it public, or how a private deploy host authenticates), and an idempotency note (re-push overwrites tags). This is the single source stories 004 (prod compose `image:` line) and 005 (deploy docs) cite.
**Diff shape:**
- Add: new file with the sections enumerated in "New Types / Schemas / Contracts" below.
- Remove: nothing.
- Change: nothing.

Contract content outline (the file's sections):
- **Title + intro** — `# Contract: Published server image (M5 story 002)`; one paragraph stating it is authoritative for the image stories 004/005 pull, and that the version derivation is inherited from `versioning.md`.
- **Image reference** — full name `ghcr.io/tdmiller1/discord-clone-server`, broken into registry `ghcr.io`, namespace/owner `tdmiller1`, repository `discord-clone-server`.
- **Tags published** — `:<version>` (immutable-per-release, e.g. `:0.2.0`) and `:latest` (moves to the newest release). State that `<version> = ${GITHUB_REF_NAME#v}` from `versioning.md`.
- **Supported architecture** — `linux/amd64`, glibc (Debian bookworm) only; explicitly NOT arm64 (mediasoup glibc worker + `better-sqlite3`). Pulling on arm64 will not run.
- **Pull & run** — `docker pull ghcr.io/tdmiller1/discord-clone-server:<version>` and a minimal `docker run` exposing `8080` + the UDP RTC range, with `-v` for `/data`, that serves `/health` (the AC's verification command).
- **Package visibility** — GHCR packages default to **private** on first publish; the workflow cannot flip visibility (it can push but not change package settings). Document the manual "Package settings → Change visibility → Public" step to make `:latest`/`:<version>` anonymously pullable, **or** that a private-kept image requires `docker login ghcr.io` on the deploy host with a `read:packages` token. Stories 004/005 must surface whichever path the admin chooses.
- **Idempotency** — re-running the workflow / re-pushing a tag overwrites the `<version>` and `latest` tags (registry overwrite-by-tag); no "already exists" failure.
- **Build provenance** — built from the repo's existing multi-stage `server/Dockerfile` (`runtime` stage), context `server/`, on `ubuntu-latest`; no second Dockerfile, no SBOM/signing (feature non-goals).

## New Types / Schemas / Contracts

This story introduces no code types. The authoritative artifact is `contracts/server-image.md`. The data shape downstream stories (004 prod compose, 005 docs) treat as authoritative:

```
Published image (authoritative):
  full name   : ghcr.io/tdmiller1/discord-clone-server
    registry  : ghcr.io
    namespace : tdmiller1          (== repo owner, from git remote; already lowercase)
    repository: discord-clone-server

Tags pushed on every v* release:
  :<version>   e.g. :0.2.0     # <version> = ${GITHUB_REF_NAME#v}  (from versioning.md)
  :latest                      # moves to the newest released version

Architecture:
  linux/amd64, glibc (bookworm)  only        # NOT arm64 (mediasoup worker + better-sqlite3)

Pull / run (serves /health):
  docker pull ghcr.io/tdmiller1/discord-clone-server:<version>
  docker run --rm -p 8080:8080 ghcr.io/tdmiller1/discord-clone-server:<version>
  # full deploy adds: -p 40000-40010:40000-40010/udp, -v <vol>:/data, PUBLIC_HOST=... (story 004)

Visibility:
  default = PRIVATE on first publish; admin makes it Public in GHCR package settings,
  or the deploy host runs `docker login ghcr.io` with a read:packages token.

Idempotency:
  re-push of an existing tag overwrites :<version> and :latest (no failure).
```

## Configuration / Environment Changes

- **`permissions: packages: write` (+ `contents: read`)** — declared at the **job level** on the new `release-server-image` job in `.github/workflows/ci.yml`. Required for the workflow `GITHUB_TOKEN` to push to GHCR. Default repo token permissions are otherwise unchanged; no workflow-level `permissions:` block is added (so the existing jobs are unaffected).
- **`secrets.GITHUB_TOKEN`** — the GitHub-provided, auto-injected token used for `docker login ghcr.io`. **No registration needed** (provided by Actions automatically); no PAT or manual registry secret is created.
- **`env.IMAGE = ghcr.io/tdmiller1/discord-clone-server`** — a job-scoped env var (convenience literal), not a repo/org secret. Registered inline in the job. The owner `tdmiller1` is hardcoded (already lowercase per `git remote`; matches the `versioning.md` committed string).
- No new server runtime env vars, no `loadConfig()`/`server/.env.example` changes, no GHCR registry settings created in code (visibility is a manual GHCR UI action documented in the contract).

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| CI job (release) | `release-server-image` (in `ci.yml`) | a pushed `v*` git tag (`GITHUB_REF_NAME`); `GITHUB_TOKEN` | pushes `ghcr.io/tdmiller1/discord-clone-server:<version>` + `:latest` to GHCR | Additive, tag-gated (`if: startsWith(github.ref,'refs/tags/v')`); `needs: release-version-guard`; no-op on branch/PR/dispatch. Existing jobs unchanged. |
| Published OCI image | `ghcr.io/tdmiller1/discord-clone-server:<version>` / `:latest` | `docker pull` | amd64/glibc server image (runtime stage of `server/Dockerfile`); `docker run` serves `/health`, `EXPOSE 8080`, `VOLUME /data` | The release deliverable. Consumed by story 004 (prod compose `image:`) and 005 (docs). |
| Contract artifact | `contracts/server-image.md` | — | the image reference, tag scheme, arch, pull command, visibility notes | Authoritative for stories 004 and 005. |

## Edge Cases & Gotchas

- **Idempotent / re-runnable release** (AC) — registry push is overwrite-by-tag, so re-pushing `v<version>` or re-running the workflow simply overwrites `:<version>` and `:latest`; no "already exists" error. Handled by Step 1 (plain `docker push`, no `--no-clobber` / "create-only" semantics) and documented in Step 2.
- **Token leakage in logs/process table** (judgment call b) — `docker login` uses `--password-stdin` (token piped via `echo … | docker login`) instead of `-p <token>` so the secret is not exposed on the command line; satisfies the `GITHUB_TOKEN` auth AC. Handled in Step 1.
- **Version-mismatched tag should not publish** (judgment call a) — `needs: release-version-guard` chains the publish after story 001's guard, so a tag whose stripped version ≠ committed `package.json` `.version` fails the guard and skips the image push. Handled in Step 1. (Does not modify the guard job.)
- **GHCR lowercase-path requirement** — GHCR rejects uppercase in the image path; owner `tdmiller1` is already lowercase, so the hardcoded literal is safe with no `tr '[:upper:]' '[:lower:]'` step. Noted in Step 1/Decision 5.
- **Preserve glibc/amd64** (AC) — building on the amd64 `ubuntu-latest` runner with the default platform and the bookworm-based `server/Dockerfile` (NOT alpine) yields amd64/glibc; no `--platform`/buildx is used (multi-arch is a non-goal). Handled in Step 1; documented in the contract's arch section.
- **Existing per-change CI unchanged** (AC) — the change is purely additive (one new job, no edits to `on:` or the `server`/`client`/guard jobs); job-level `permissions` keeps the other jobs' token scope intact. Handled by Step 1's additive-only constraint.
- **Reuse the single Dockerfile** (AC + feature constraint) — `working-directory: server` + `docker build … .` reuses `server/Dockerfile` + `server/.dockerignore`; no second Dockerfile is authored. Handled in Step 1.
- **Package visibility defaults to private** (feature edge case) — the workflow can push but cannot make the package public; the contract (Step 2) documents the manual "make Public" step and the private-pull `docker login` alternative for stories 004/005.
- **Concurrency on the same workflow** (story-003 wave note) — story 003 also edits `ci.yml` in this wave; designing this as a self-contained additive job that only `needs: release-version-guard` avoids any dependency on or conflict with story 003's job(s). Handled by Step 1's additive design.

## Acceptance Criteria Checklist

- [ ] Release workflow triggers on `v*` tag push and builds & pushes the server image to GHCR at `ghcr.io/tdmiller1/discord-clone-server` → Step 1 (`if: startsWith(github.ref,'refs/tags/v')`; on-block already has `tags:['v*']` from story 001).
- [ ] Image tagged with both the release `<version>` and `latest`, reusing the existing multi-stage `server/Dockerfile` (no second Dockerfile) → Step 1 (`docker build -t $IMAGE:$VERSION -t $IMAGE:latest .` from `working-directory: server`).
- [ ] Job authenticates with the workflow `GITHUB_TOKEN` and declares `permissions: packages: write`; login→build→push works with no manual creds → Step 1 (job-level `permissions: { contents: read, packages: write }`; `docker login ghcr.io … --password-stdin`).
- [ ] Image preserves glibc/amd64 (mediasoup worker + `better-sqlite3`); build targets linux/amd64 (no multi-arch) → Step 1 (default-platform build on amd64 `ubuntu-latest`, bookworm Dockerfile, no buildx).
- [ ] Idempotent / re-runnable: re-running for an existing tag overwrites the version tag predictably and does not fail → Step 1 (overwrite-by-tag `docker push`); documented in Step 2.
- [ ] Existing per-change CI (server build + `/health` smoke + `docker build`, client `tauri build`) unchanged and still runs on push/PR — release path additive → Step 1 (no edits to `on:`/`server`/`client`/guard jobs; new job tag-gated).
- [ ] `contracts/server-image.md` records the full registry path, the `<version>`+`latest` tag scheme, the supported arch (amd64/glibc), and package-visibility notes for stories 004/005 → Step 2.
- [ ] Acceptance verification: a pushed test `v*` tag produces a pullable image; `docker pull …:<version>` then `docker run` serves `/health` → Step 1 (produces the image) + Step 2 (documents the exact pull/run/health command).
