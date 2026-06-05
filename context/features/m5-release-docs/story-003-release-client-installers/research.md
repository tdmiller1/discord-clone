#research

# Research: Tag-triggered — attach Windows/Linux installers to a GitHub Release

## Files to Touch

### Likely Modified
- `.github/workflows/ci.yml` — the entire release wiring lives here. The existing `client` job already builds the Tauri installers on the `ubuntu-latest + windows-latest` matrix and uploads them as ephemeral workflow artifacts with `if-no-files-found: warn` (lines 56–99). Story 001 already added the `tags: ['v*']` trigger (lines 4–6) and the `release-version-guard` job (lines 11–28). This story redirects the matrix build output to a durable GitHub Release on `v*` tags while keeping the per-change push/PR artifact path intact.

### Likely Created
- `context/features/m5-release-docs/story-003-release-client-installers/contracts/release-assets.md` — the contract this story `provides_contract`. Must record the Release tag/name pattern (`v<version>` / `<version>`), the exact asset filenames per OS, and the "release fails if an installer is missing" guarantee, for story 005's download instructions. (The `contracts/` subdir does not exist yet — story 001 created its own under `story-001-release-versioning/contracts/`; mirror that layout.)

### Read-Only Reference (patterns to follow)
- `context/features/m5-release-docs/story-001-release-versioning/contracts/versioning.md` — THE upstream contract. Tag→version derivation is `VERSION="${GITHUB_REF_NAME#v}"` (strip one leading `v`); installer versions come from `tauri.conf.json` `.version` (== committed `0.2.0`), which `tauri build` stamps into the bundle filenames. The Release tag/name is `v<version>`. The `release-version-guard` job (only runs on `v*` tags) already guarantees the tag matches the committed version before any release proceeds.
- `.github/workflows/ci.yml` `client` job (lines 56–99) — the build recipe to reuse verbatim: Linux apt deps (libwebkit2gtk-4.1-dev, etc.), `setup-node@v4` node 24 + npm cache, `dtolnay/rust-toolchain@stable`, `swatinem/rust-cache@v2`, `npm ci`, `npm run icons` (generates `src-tauri/icons/`), `npm run tauri build`. The bundle output globs are already enumerated on lines 95–98.
- `client/src-tauri/tauri.conf.json` — `productName: "discord-clone"`, `version: "0.2.0"`. These two fields determine the installer filenames (see Data Flow).

## Existing Patterns

**CI workflow shape.** A single `.github/workflows/ci.yml` holds everything. Jobs are top-level keys with `name:`, `runs-on:`, optional `strategy.matrix`, `defaults.run.working-directory`, and `steps`. Tag-only jobs gate with `if: startsWith(github.ref, 'refs/tags/v')` (see `release-version-guard`, line 14). There are **no `permissions:` blocks anywhere** in the repo today and **no release tooling** (no `softprops/action-gh-release`, no `gh release`, no `GITHUB_TOKEN` usage) — this story introduces the first one.

**The client build job (lines 56–99) is the canonical Tauri build.** It is matrixed `os: [ubuntu-latest, windows-latest]` with `fail-fast: false`, `working-directory: client`. After `npm run tauri build`, the "Upload installers" step (lines 90–99) globs:
```
client/src-tauri/target/release/bundle/**/*.AppImage
client/src-tauri/target/release/bundle/**/*.deb
client/src-tauri/target/release/bundle/**/*.msi
client/src-tauri/target/release/bundle/**/*.exe
```
with `if-no-files-found: warn`. The story explicitly requires replacing that tolerant `warn` so a missing installer **fails** the release.

**`tauri.conf.json` `bundle.targets: "all"`** means a Linux build emits both `.AppImage` (`bundle/appimage/`) and `.deb` (`bundle/deb/`), and a Windows build emits `.msi` (`bundle/msi/`) and NSIS `.exe` (`bundle/nsis/`). Confirmed on disk: a prior local Linux build left `bundle/appimage/discord-clone_0.1.0_amd64.AppImage` and `bundle/deb/discord-clone_0.1.0_amd64.deb` (the `0.1.0` is stale from before story 001's version reconciliation — actual releases will stamp `0.2.0`).

**Version is NOT re-maintained here.** Per the upstream contract, installer versions flow from `tauri.conf.json` `.version`; the guard already enforces tag==committed before the release job runs. The Release tag/name is derived as `v<version>` where `<version> = ${GITHUB_REF_NAME#v}` — but for naming the GitHub Release, the tag name `GITHUB_REF_NAME` (already `v0.2.0`) can be used directly since the Release IS for that tag.

## Data Flow

Tag push → version → Release with attached installers:

1. Maintainer pushes `git tag v0.2.0 && git push origin v0.2.0`.
2. CI fires on `tags: ['v*']`. `release-version-guard` runs first (story 001) and asserts `${GITHUB_REF_NAME#v}` == `package.json` `.version` (`0.2.0`); on mismatch it `exit 1` and nothing publishes.
3. The client matrix builds on ubuntu + windows. `npm run tauri build` reads `tauri.conf.json` (`productName: discord-clone`, `version: 0.2.0`) and writes version-stamped bundles:
   - Linux (`ubuntu-latest`): `target/release/bundle/appimage/discord-clone_0.2.0_amd64.AppImage`, `target/release/bundle/deb/discord-clone_0.2.0_amd64.deb`
   - Windows (`windows-latest`): `target/release/bundle/msi/discord-clone_0.2.0_x64_en-US.msi`, `target/release/bundle/nsis/discord-clone_0.2.0_x64-setup.exe`
4. On a `v*` tag (and only then), each matrix leg attaches its bundles as **release assets** to a GitHub Release for the tag (created or reused). On push/PR (non-tag), the existing ephemeral `upload-artifact` path remains so per-change builds still produce downloadable artifacts.
5. If a leg produced no installer, the release **fails** (no silent empty release).
6. Story 005 reads `contracts/release-assets.md` to write README download links pointing at `https://github.com/tdmiller1/discord-clone/releases/tag/v<version>` and the asset filenames.

Note: `VITE_SERVER_URL` (baked into the *web* bundle via `client/Dockerfile.web`) is irrelevant to the desktop installer build — `npm run tauri build` leaves it unset, so installers default to `http://localhost:8080` with the user overriding on the login screen (existing behavior, `client/src/lib/config.ts`). No change here.

## Decisions Made

1. **Implement as additive steps inside the existing `client` job in `ci.yml`, not a separate `release.yml`.** The matrix build (apt deps, rust cache, icon gen, `tauri build`) is expensive and already correct; duplicating it into a second workflow would diverge. The release behavior is a per-matrix-leg conditional (`if: startsWith(github.ref, 'refs/tags/v')`) added after the build, exactly like the existing `release-version-guard` gating pattern. Story 002 (server image → GHCR) is independent and can live in its own job/file; the two share only the trigger.

2. **Use `softprops/action-gh-release@v2` to create/reuse the Release and upload assets.** It is the de-facto standard for this, is natively idempotent (re-running for an existing tag updates the same Release; `files:` clobbers same-named assets), creates the Release if absent, names/tags it from the pushed tag automatically, and supports `fail_on_unmatched_files: true` to satisfy the "missing installer fails the release" criterion. Each matrix leg uploads only its own OS's files to the same `tag_name`, which the action merges into one Release — avoiding cross-OS artifact-passing complexity. Rationale over hand-rolling `gh release create`: gh would need explicit "create if not exists / else upload --clobber" branching to be idempotent and to avoid the "release already exists" crash; the action handles both natively. (Plan phase will confirm exact action inputs; this is the chosen approach.)

3. **Job-level `permissions: contents: write`.** Required to create the Release and upload assets via the workflow `GITHUB_TOKEN` (acceptance criterion). No repo-wide default-permissions block exists today, so add it scoped to the job that publishes (or the workflow) — narrowest viable. (Story 002's `packages: write` is a separate, independent grant.)

4. **Set `fail_on_unmatched_files: true` and keep per-OS file globs precise** so a leg that built nothing fails rather than publishing a partial Release. This replaces the spirit of the tolerant `if-no-files-found: warn`. Keep the existing `upload-artifact@v4` step for the non-tag (push/PR) path so the per-change gate is unchanged — only add the Release-upload step gated on the tag condition.

5. **Reuse the four existing bundle globs** (`**/*.AppImage`, `**/*.deb`, `**/*.msi`, `**/*.exe`) for the upload `files:` rather than hardcoding `discord-clone_<version>_...` names. The globs are version-agnostic and OS-correct (each leg only produces its own OS's two formats), so they survive version bumps and avoid duplicating the tag→version derivation. The contract documents the concrete stamped names for story 005's prose.

6. **Contract records concrete artifact names with the `<version>` placeholder.** `release-assets.md` will state: Release tag/name `v<version>`; assets `discord-clone_<version>_amd64.AppImage`, `discord-clone_<version>_amd64.deb`, `discord-clone_<version>_x64_en-US.msi`, `discord-clone_<version>_x64-setup.exe`; Release URL `https://github.com/tdmiller1/discord-clone/releases/tag/v<version>`; and the "release fails if any of the four installers is missing" guarantee — matching the upstream contract's `<version>` convention.
