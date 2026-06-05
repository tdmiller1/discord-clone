---
story: 002
title: Tag-triggered — build & push the server image to GHCR
status: TODO
depends_on: [001]
provides_contract: contracts/server-image.md
---

#story

# Story 002: Tag-triggered — build & push the server image to GHCR

## User Story
As an admin deploying the server, I want each `vX.Y.Z` tag to publish a ready-to-pull server image to a registry so that I can `docker run`/`docker compose pull` the exact released version without building from source.

## Acceptance Criteria
- [ ] A release workflow (extend `.github/workflows/ci.yml` or add a dedicated `release.yml`) triggers on **`v*` tag push** and **builds & pushes** the server OCI image to **GHCR** at `ghcr.io/<owner>/discord-clone-server`.
- [ ] The image is tagged with both the **release version** from the tag (story 001's contract, e.g. `0.2.0`) and **`latest`**; the build reuses the existing multi-stage `server/Dockerfile` (no second Dockerfile).
- [ ] The job authenticates with the workflow `GITHUB_TOKEN` and declares `permissions: packages: write`; login → build → push works in CI (no manual registry credentials).
- [ ] The pushed image preserves the glibc/amd64 runtime constraint (mediasoup worker + `better-sqlite3`); the build targets **linux/amd64** (no multi-arch).
- [ ] **Idempotent / re-runnable:** re-running the workflow for an existing tag overwrites the version tag predictably and does not fail the job.
- [ ] The existing per-change CI (server build + `/health` smoke + `docker build`, client `tauri build`) is unchanged and still runs on push/PR — the release path is additive.
- [ ] `contracts/server-image.md` records: the full registry path (`ghcr.io/<owner>/discord-clone-server`), the tag scheme (`<version>` + `latest`), the supported arch (amd64/glibc), and package-visibility notes (default-private, how it's made pullable) — for stories 004 and 005.

## Acceptance verification
- [ ] Pushing a test `v*` tag (or a `workflow_dispatch` dry run) produces a pullable image in GHCR; `docker pull ghcr.io/<owner>/discord-clone-server:<version>` then `docker run` serves `/health`.

## Context
CI today tags the server image `discord-clone-server:ci` and **never pushes it** (`.github/workflows/ci.yml` step "Build Docker image"). `SPEC.md §5` lists the OCI image as deliverable #1; `§14 M5` requires a tag to publish it. The `server/Dockerfile` is already a correct multi-stage glibc build with a `HEALTHCHECK`; this story wires its output to a registry on tags. Depends on story 001 for the tag→version mapping that names the image tag.

## Out of Scope
- The GitHub Release and the client installers (story 003) — this story publishes only the server image.
- The production compose that *pulls* this image and the deploy docs (stories 004, 005).
- Multi-arch/arm64 images and image signing/SBOM (feature non-goals).
