---
story: 001
title: Single source-of-truth version derived from the git tag
status: TODO
depends_on: []
provides_contract: contracts/versioning.md
---

#story

# Story 001: Single source-of-truth version derived from the git tag

## User Story
As the admin releasing the project, I want one coherent version that comes from the git tag so that the published image, the GitHub Release, and the installed client all report the same version and never silently diverge.

## Acceptance Criteria
- [ ] The current drift is resolved: `client/src-tauri/tauri.conf.json` (`0.1.0`) is reconciled with `package.json` versions (`0.2.0`) so **all** version fields agree at rest — root `package.json`, `server/package.json`, `client/package.json`, and `tauri.conf.json`.
- [ ] A documented **tag → version convention** is established: a `vX.Y.Z` git tag is the release's source of truth, and the version stamped into the image tag (story 002), the GitHub Release (story 003), and the installer/`tauri.conf.json` derives from it (e.g. strip the leading `v`). The mechanism is concrete — either CI writes the version from the tag before building, or a small bump script + a "the tag MUST match the committed version" guard.
- [ ] If CI mutates `tauri.conf.json`/`package.json` versions at build time from the tag, it does so **without committing** churn back to `main` (build-time stamp only) — or, if the version is committed, a guard **fails the release** when the pushed tag does not match the committed version (covers the "tag pushed without a version bump" edge case).
- [ ] No new third place to maintain the version is introduced; the convention reduces, not multiplies, the spots a human edits.
- [ ] `npm run typecheck` still passes; `tauri.conf.json` remains valid (the client still builds).
- [ ] `contracts/versioning.md` records: the `vX.Y.Z` tag scheme, where the version lives, exactly how the release version is derived from the tag, and the guard behavior on mismatch — for stories 002, 003, and 005.

## Context
The repo has **no git tags** yet and an active version drift: `tauri.conf.json` is `0.1.0` while root/`server`/`client` `package.json` are all `0.2.0`. M5's release (`SPEC.md §14`) is **tag-driven**, so the version must be anchored to the tag and made coherent before the image-publish (002) and installer-Release (003) stories stamp artifacts with it. This is the foundational story for the milestone — it establishes the contract the publishing stories consume.

## Out of Scope
- The actual image build/push (story 002) and the GitHub Release/installer upload (story 003) — this story only fixes the version's source of truth and the tag convention they rely on.
- Release-notes / changelog automation or semantic-release tooling (feature non-goal).
- Bumping to a *new* version number as part of this story; reconciling to the existing `0.2.0` is sufficient unless a bump is trivially warranted.
