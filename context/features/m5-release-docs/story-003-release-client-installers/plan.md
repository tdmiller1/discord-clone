#plan

# Plan: Story 003 — Tag-triggered: attach Windows/Linux installers to a GitHub Release

## Summary
On a `v*` tag push, reuse the existing `client` matrix `tauri build` (ubuntu + windows) and, as an additive per-leg step, attach the produced `.msi`/`.exe` (Windows) and `.AppImage`/`.deb` (Linux) installers as assets to a GitHub Release for that tag via `softprops/action-gh-release@v2` — created/reused idempotently, failing the release if any matched-installer file is missing — while leaving the existing ephemeral `upload-artifact` path intact for push/PR. A `contracts/release-assets.md` records the Release tag/URL pattern and exact per-OS asset filenames for story 005.

## Implementation Steps

### Step 1: Add `permissions: contents: write` to the `client` job
**File(s):** `.github/workflows/ci.yml`
**Action:** modify
**Description:** The release-upload step needs to create the Release and upload assets through the workflow `GITHUB_TOKEN`. No repo-wide or default `permissions:` block exists today, and the implicit default token is read-only for `contents`, so grant `contents: write` scoped to the `client` job (narrowest viable — story 002's `packages: write` is a separate grant on its own job and does not conflict). Add the block at the `client` job level, immediately under `name: Client (tauri build)` (peer of `strategy`/`runs-on`/`defaults`).
**Diff shape:**
- Add: a `permissions:` block on the `client` job:
  ```yaml
  client:
    name: Client (tauri build)
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
  ```
- Remove: nothing
- Change: nothing else in the job header

### Step 2: Add the tag-gated "Attach installers to GitHub Release" step to the `client` matrix job
**File(s):** `.github/workflows/ci.yml`
**Action:** modify
**Description:** After the existing "Upload installers" (`actions/upload-artifact@v4`) step, add a new step that runs **only on `v*` tag pushes** and uploads each matrix leg's own OS bundles as assets to a single GitHub Release for the pushed tag. Use `softprops/action-gh-release@v2`: it creates the Release if absent and reuses it if present (idempotent across re-runs and across the two matrix legs, which converge on the same `tag_name`), clobbers same-named assets rather than duplicating them, derives the Release tag/name from the pushed tag, and with `fail_on_unmatched_files: true` fails the run if any of its `files:` globs matches nothing — satisfying the "missing installer fails the release" criterion. The existing `upload-artifact` step is unchanged so the per-change push/PR artifact path remains intact (the release step is additive and tag-gated). Reuse the four existing version-agnostic bundle globs for `files:` (each leg only emits its own OS's two formats, so this stays correct across version bumps without re-deriving `<version>`). Let the action default to the implicit `GITHUB_TOKEN` (no explicit `token:` needed once job permissions grant `contents: write`).
**Diff shape:**
- Add: after the `Upload installers` step (current line 90–99), a new step:
  ```yaml
      - name: Attach installers to GitHub Release
        if: startsWith(github.ref, 'refs/tags/v')
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ github.ref_name }}
          fail_on_unmatched_files: true
          files: |
            client/src-tauri/target/release/bundle/**/*.AppImage
            client/src-tauri/target/release/bundle/**/*.deb
            client/src-tauri/target/release/bundle/**/*.msi
            client/src-tauri/target/release/bundle/**/*.exe
  ```
- Remove: nothing — the `if-no-files-found: warn` artifact step stays for the push/PR gate (the "fail if missing" guarantee is enforced on the release step via `fail_on_unmatched_files`, leaving per-change builds tolerant as before).
- Change: nothing in the existing build steps. (NOTE on serialization with story-002: this is a new step inside the existing `client` job and a job-level `permissions` grant; story-002's additive server-image job is independent — no shared keys beyond the already-present `tags: ['v*']` trigger from story 001.)

### Step 3: Create the `contracts/release-assets.md` contract
**File(s):** `context/features/m5-release-docs/story-003-release-client-installers/contracts/release-assets.md`
**Action:** create
**Description:** Create the `contracts/` subdir (does not exist yet) mirroring story 001's layout and write the contract this story `provides_contract`. It must authoritatively record, for story 005's download instructions: the Release tag/name pattern (`v<version>`), the canonical Release URL, the exact per-OS asset filenames with `<version>` substitution (the names `tauri build` stamps from `tauri.conf.json` `productName: discord-clone` + `version`), the `<version>` derivation rule (deferring to the upstream versioning contract), and the "release fails if any installer is missing" guarantee. Use `tdmiller1` as the repo owner (confirmed via `git remote`).
**Diff shape:**
- Add: new file documenting (concrete content in "New Types / Schemas / Contracts" below).

## New Types / Schemas / Contracts

This story introduces one contract file. Its authoritative content (downstream story 005 treats this as the source of truth for download prose):

`contracts/release-assets.md`:

- **Release tag / name:** `v<version>` (e.g. `v0.2.0`). The GitHub Release is created (or reused) for the pushed git tag; its tag and display name are the tag name `${{ github.ref_name }}` (`v<version>`).
- **`<version>` derivation:** `<version> = ${GITHUB_REF_NAME#v}`, equal to the committed root `package.json` `.version` (enforced by story 001's `release-version-guard` before any release proceeds). Per the upstream `versioning.md` contract.
- **Release URL:** `https://github.com/tdmiller1/discord-clone/releases/tag/v<version>`
- **Latest release shortcut:** `https://github.com/tdmiller1/discord-clone/releases/latest`
- **Published assets (exactly four, two per OS):**

  | OS | Format | Asset filename |
  | --- | --- | --- |
  | Windows | MSI installer | `discord-clone_<version>_x64_en-US.msi` |
  | Windows | NSIS setup `.exe` | `discord-clone_<version>_x64-setup.exe` |
  | Linux | AppImage (portable) | `discord-clone_<version>_amd64.AppImage` |
  | Linux | Debian package | `discord-clone_<version>_amd64.deb` |

  Filenames are produced by `tauri build` from `tauri.conf.json` `productName` (`discord-clone`) + `version` (`<version>`); the story does not hardcode them in CI (version-agnostic globs upload whatever the build stamps).
- **Arch:** amd64/x64 only (feature non-goal: arm64). No macOS assets (feature non-goal).
- **Signing:** installers are unsigned — Windows SmartScreen / Linux "untrusted AppImage" warnings are expected (story 005 documents the user-facing warning).
- **Missing-installer guarantee:** the release step uses `fail_on_unmatched_files: true`, so if a matrix leg fails to produce any one of its expected installer formats, the workflow fails and no partial Release with a missing OS installer is published.
- **Idempotency:** re-running the workflow for an existing tag updates the same Release and clobbers same-named assets (no "release already exists" crash, no duplicate assets).

## Configuration / Environment Changes

- **GitHub Actions permission `contents: write`** — default: not granted (no `permissions:` block exists today; implicit `GITHUB_TOKEN` is read-only for `contents`). Registered at the `client` job level in `.github/workflows/ci.yml` (Step 1). Required to create the Release and upload assets.
- **New action dependency `softprops/action-gh-release@v2`** — registered via the `uses:` of the new release step (Step 2). No secret needed beyond the auto-provided `GITHUB_TOKEN`.
- No new env vars, no `server/.env.example` change, no `loadConfig()` change. `VITE_SERVER_URL` is irrelevant to the desktop installer build (unset → defaults to `localhost:8080`, existing behavior).

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| GitHub Release | tag `v<version>` | `git push origin v<version>` (after committed version bumped to `<version>`) | A GitHub Release at `releases/tag/v<version>` with 4 installer assets attached | Created/reused idempotently; fails if any installer missing |
| CI workflow | `client` job (`.github/workflows/ci.yml`) | `v*` tag push | Release assets uploaded per matrix leg; push/PR runs still upload ephemeral artifacts | Release step gated on `startsWith(github.ref, 'refs/tags/v')` |
| Contract file | `contracts/release-assets.md` | n/a | Asset-name + URL + tag spec | Consumed by story 005 |

## Edge Cases & Gotchas

- **Missing installer in the matrix** — handled in Step 2 via `fail_on_unmatched_files: true` (replaces the spirit of the tolerant `if-no-files-found: warn` for the release path; the artifact step stays tolerant for per-change builds).
- **Re-run / re-pushed / moved tag (idempotency)** — handled in Step 2: `action-gh-release` reuses the existing Release for the tag and clobbers same-named assets instead of erroring or duplicating.
- **Two matrix legs writing to one Release** — handled in Step 2: both legs target the same `tag_name`; the action merges each leg's assets into the single Release (each leg uploads only its own OS's two files via the OS-specific bundle output), avoiding cross-OS artifact passing. With `fail-fast: false`, a failed leg does not cancel the other, but a leg's `fail_on_unmatched_files` failure still fails the overall workflow.
- **Release fires on non-bumped tag** — already prevented upstream: story 001's `release-version-guard` runs on the same `v*` trigger and `exit 1`s on tag≠committed mismatch. This story does not re-implement the guard; it relies on the guard job failing the run (the `client` release step is not ordered after the guard, but a guard failure fails the workflow as a whole — both run on the tag, and a failed guard marks the run failed). No `needs:` dependency is added (none exists today; keeping the additive change minimal), consistent with the guard being an independent gate on the same trigger.
- **Permissions scope** — handled in Step 1: `contents: write` is scoped to the `client` job, not repo-wide, and is independent of story 002's `packages: write`.
- **`contents: write` token works on tag refs** — `action-gh-release` operates on the tag ref of the push; the implicit `GITHUB_TOKEN` with `contents: write` is sufficient (no PAT required) for same-repo Releases.
- **Version-agnostic globs survive version bumps** — handled in Step 2: `files:` reuses the four existing globs rather than hardcoding `discord-clone_0.2.0_*`, so future tags need no CI edit; the concrete names live only in the contract prose.
- **Push/PR path unchanged** — handled in Step 2 by leaving the `upload-artifact@v4` step in place and gating only the new step on the tag condition (acceptance: "per-change CI's existing `tauri build` + artifact-upload job remains intact").

## Acceptance Criteria Checklist

- [ ] On `v*` tag push, client builds on ubuntu+windows (reusing matrix/deps/icons/`tauri build`) and `.msi`/`.exe` + `.AppImage`/`.deb` are attached to a GitHub Release (not just ephemeral artifacts) → Step 2
- [ ] Release created/reused for the tag, named/tagged from story 001's version (`v<version>`), installers uploaded as release assets with `tauri build`'s version-stamped names → Step 2 (+ derivation per `versioning.md`)
- [ ] A missing installer fails the release (replaces tolerant `if-no-files-found: warn` for the release path) → Step 2 (`fail_on_unmatched_files: true`)
- [ ] Idempotent / re-runnable: re-running for an existing tag uploads assets cleanly (clobber/replace) without "release already exists" error or duplicate assets → Step 2 (action behavior)
- [ ] Job has `contents: write` to create the Release and upload assets via `GITHUB_TOKEN` → Step 1
- [ ] Per-change CI's existing `tauri build` + artifact-upload job remains intact for push/PR (release path is additive) → Step 2 (existing step untouched; new step tag-gated)
- [ ] `contracts/release-assets.md` records Release URL/tag pattern, exact asset filenames/extensions per OS, and the "release fails if installer missing" guarantee → Step 3
- [ ] Acceptance verification: pushing a test `v*` tag yields a Release whose assets include a Windows installer and a Linux `.AppImage` (downloadable + launchable) → Step 1 + Step 2 (manual verification on a pushed test tag)
