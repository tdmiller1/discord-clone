---
story: 003
title: Tag-triggered — attach Windows/Linux installers to a GitHub Release
status: TODO
depends_on: [001]
provides_contract: contracts/release-assets.md
---

#story

# Story 003: Tag-triggered — attach Windows/Linux installers to a GitHub Release

## User Story
As a user installing the client, I want each `vX.Y.Z` release to have the Windows and Linux installers attached so that I can download and install the app from the Release page without building it myself.

## Acceptance Criteria
- [ ] On **`v*` tag push**, the client is built on **ubuntu-latest + windows-latest** (reuse the existing matrix, Linux build deps, icon generation, and `tauri build` steps) and the resulting **`.msi`/`.exe` (Windows)** and **`.AppImage`/`.deb` (Linux)** are **attached to a GitHub Release** for that tag (not just uploaded as ephemeral workflow artifacts).
- [ ] The Release is created (or reused) for the tag, named/tagged from story 001's version, and the installers are uploaded as **release assets** with the version-stamped names `tauri build` produces.
- [ ] **A missing installer fails the release** — replace the current tolerant `if-no-files-found: warn` behavior so a Release is **not** published if the Windows or Linux installer is absent (covers the "missing installer in the matrix" edge case).
- [ ] **Idempotent / re-runnable:** re-running for an existing tag uploads assets cleanly (clobber/replace) without erroring on "release already exists" or duplicating assets.
- [ ] The job has the permissions it needs (`contents: write`) to create the Release and upload assets via `GITHUB_TOKEN`.
- [ ] The per-change CI's existing `tauri build` + artifact-upload job remains intact for push/PR (the release path is additive).
- [ ] `contracts/release-assets.md` records: the Release URL/tag pattern, the exact asset filenames/extensions per OS, and the "release fails if an installer is missing" guarantee — for story 005's download instructions.

## Acceptance verification
- [ ] Pushing a test `v*` tag yields a GitHub Release whose assets include a Windows installer and a Linux `.AppImage`; downloading and launching the Linux artifact opens the app.

## Context
CI currently runs `tauri build` and uploads the installers as **workflow artifacts** with `if-no-files-found: warn` (`.github/workflows/ci.yml` client job) — ephemeral and silently tolerant of absence. `SPEC.md §5` lists the Windows + Linux installers as deliverables #2 and #3, and `§14 M5` requires a tag to publish them. This story redirects that build output to a durable GitHub Release. Depends on story 001 for the tag→version naming. Parallel to story 002 (server image → GHCR needs no Release; installers → Release need no GHCR), so the two release jobs are independent.

## Out of Scope
- The server image publish (story 002).
- Code signing / notarization and auto-update (feature non-goals) — installers ship unsigned; documenting the SmartScreen warning is story 005.
- macOS installers (feature non-goal).
- The README download/install instructions themselves (story 005 consumes this contract).
