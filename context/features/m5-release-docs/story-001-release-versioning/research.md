#research

# Research: Single source-of-truth version derived from the git tag

## Files to Touch

### Likely Modified
- `client/src-tauri/tauri.conf.json` — `version` is `0.1.0`; reconcile to `0.2.0` so it agrees with the three `package.json` files. This is the value `tauri build` stamps into the `.msi`/`.exe`/`.AppImage`/`.deb` (story 003 consumes those names).
- `client/src-tauri/Cargo.toml` — `version = "0.1.0"` (line 3) also lags. Tauri prefers `tauri.conf.json`'s `version` for bundling, but Cargo.toml is the crate's own version and a third disagreeing literal; reconcile to `0.2.0` to make "all version fields agree at rest" actually true.
- `server/src/app.ts` — line 123 hardcodes `version: "0.1.0"` in the `GET /` info route response, lagging the `0.2.0` package.json. Reconcile this literal too (it is the only runtime-visible version surface in the server). Decide whether to leave it as a reconciled literal or read it from `package.json` (see Decisions).
- `client/src-tauri/Cargo.lock` — the `discord-clone` package entry shows `version = "0.1.0"`; it auto-regenerates from `Cargo.toml` on the next cargo build, but should be committed in sync so CI doesn't produce churn. (Mechanical — regenerated, not hand-edited.)
- `.github/workflows/ci.yml` — add the tag→version mechanism here (or a new `release.yml`; stories 002/003 may create that). Two viable shapes: (a) a release job that, before building, stamps the version from the tag into `tauri.conf.json`/`package.json` at build time **without committing**; or (b) a guard step that fails the release when `${tag#v}` ≠ the committed version. Either way the concrete logic + which file the version is read from is decided here because 002/003 reference it.

### Likely Created
- `context/features/m5-release-docs/story-001-release-versioning/contracts/versioning.md` — the contract this story `provides_contract`. Records the `vX.Y.Z` tag scheme, the canonical place the version lives, the exact `v`-strip derivation, and the mismatch-guard behavior, for stories 002 (image tag), 003 (Release name + installer version), and 005 (docs).
- (Possibly) `scripts/check-version.sh` or `scripts/bump-version.*` — only if the plan chooses the "guard / bump script" path over a pure CI-inline step. `scripts/` already exists (holds `build_waves.py`, `resolve_story_meta.py`), so a small release helper script fits the established layout. Optional; a few lines of inline shell in the workflow may be cleaner for a single use site.

### Read-Only Reference (patterns to follow)
- `context/features/m4-voice-sfu/story-003-voice-gateway/contracts/voice-protocol.md` — canonical contract file format: starts with `#contract`, `# Contract: <title>`, a framing paragraph stating which downstream stories implement against it, then the concrete spec. Mirror this structure for `versioning.md`.
- `.github/workflows/ci.yml` — the existing two-job (`server`, `client`) workflow; the per-change gate that MUST stay intact. The release path is additive (feature constraint). Shows the existing `tauri build` matrix (ubuntu + windows), Node 24, and the `docker build` step the version stamping must slot in front of.
- `SPEC.md §5` and `§14 M5` — "CI builds all three from tagged releases"; M5 acceptance is tag-driven publish. Authoritative source for the tag-trigger requirement.
- `m5-release-docs_feature.md` — feature-level constraints: "Single source of truth for the version, derived from the tag", "No hand-maintained version in three places", and the "Tag pushed without a version bump" edge case.

## Existing Patterns

**Version sources today (the full inventory of hand-maintained version literals):**
- `package.json` → `0.2.0`
- `server/package.json` → `0.2.0`
- `client/package.json` → `0.2.0`
- `client/src-tauri/tauri.conf.json` → `0.1.0` (drifted)
- `client/src-tauri/Cargo.toml` → `0.1.0` (drifted — not mentioned in the AC but a real fourth/fifth literal)
- `server/src/app.ts:123` → `0.1.0` (drifted — runtime `GET /` info response)
- Lockfiles (`package-lock.json` ×3 root `"version"`, `Cargo.lock` `discord-clone` entry) mirror their manifests and regenerate automatically; not hand-maintained but should be committed in sync.

So the AC's "four fields" (root/server/client `package.json` + `tauri.conf.json`) is the documented minimum, but there are **two more** drifted literals (`Cargo.toml`, `app.ts`) plus auto-derived lockfiles. The AC says "**all** version fields agree at rest" — the plan should reconcile every literal, not just the four named.

**Contract file convention:** all prior `provides_contract` files live under `<story>/contracts/<name>.md`, lead with `#contract` + `# Contract: <title> (M<n> story <NNN>)`, and open with a paragraph naming the downstream consumer(s) and what is fixed vs pass-through. (See `voice-protocol.md`, `auth-api.md`, etc.) `versioning.md` should follow this exactly and name stories 002/003/005 as consumers.

**CI convention:** `.github/workflows/ci.yml` triggers on `push: [main]`, `pull_request`, `workflow_dispatch`. The release trigger is `push: tags: ['v*']` (feature constraint: tag-triggered, not push-triggered; the existing jobs stay). GitHub exposes the tag at `github.ref_name` (e.g. `v0.2.0`); stripping the leading `v` is a one-liner (`${GITHUB_REF_NAME#v}`).

**No git tags exist yet** (`git tag` is empty), so the convention is being established fresh — no legacy tag format to honor.

**`scripts/` layout:** holds Python helpers (`build_waves.py`, `resolve_story_meta.py`) for the story pipeline. A release/version helper would be the first build-tooling script there; acceptable but a single inline workflow step is also idiomatic given one use site.

## Data Flow

**At rest (what a human edits):** ideally one canonical version literal feeds everything else. Today there is no single source — six independent literals drift. After this story, the **git tag `vX.Y.Z` is the release source of truth**; the committed literals are reconciled to one number and either (a) overwritten from the tag at build time without committing, or (b) guarded to match the tag.

**Release-time flow (the contract stories 002/003 consume):**
1. Admin pushes annotated/lightweight tag `vX.Y.Z` (e.g. `v0.2.0`).
2. CI release job fires on `push: tags: ['v*']`; the version = `${GITHUB_REF_NAME#v}` (strip leading `v`).
3. Either: the job writes that version into `tauri.conf.json` (+ package.json) before `tauri build` (build-time stamp, never committed) — **or** a guard compares `${GITHUB_REF_NAME#v}` against the committed `version` and **fails the release** on mismatch (covers "tag pushed without a version bump").
4. Story 002 names the image `ghcr.io/<owner>/discord-clone-server:<version>` + `latest` from that same value.
5. Story 003 names the GitHub Release and the installer assets from that same value; `tauri build` stamps the bundle filenames with the `tauri.conf.json` version.
6. Story 005 documents `ghcr.io/<owner>/...:<version>` and the asset filenames using the convention this contract pins.

**Runtime version surface:** `server/src/app.ts` `GET /` returns `{ name, version, docs }`. This is the only place a deployed artifact reports its own version over the wire. Reconciling it keeps a running server honest about its version; whether it stays a literal or reads `package.json` is a Decision below.

**Tauri bundling:** `tauri build` reads `version` from `tauri.conf.json` (it takes precedence over `Cargo.toml` for the bundle/installer version) and stamps it into `.msi`/`.exe`/`.AppImage`/`.deb` filenames + metadata. So `tauri.conf.json` is the load-bearing file for installer versions; `Cargo.toml` is the crate version (cosmetic for distribution but a literal that should still agree).

## Decisions Made

1. **Reconcile to `0.2.0`, not a new bump.** The story's Out of Scope says reconciling to existing `0.2.0` is sufficient; three of the four named files already say `0.2.0`, so pulling the laggards up to `0.2.0` is the minimal, lowest-churn fix. First release tag will be `v0.2.0`.

2. **Reconcile ALL drifted literals, not only the four AC-named files.** The AC names root/server/client `package.json` + `tauri.conf.json`, but `Cargo.toml` and `server/src/app.ts:123` also say `0.1.0`. The AC also demands "all version fields agree at rest" and "no third place to maintain." Leaving `Cargo.toml`/`app.ts` at `0.1.0` would violate the spirit and re-introduce drift, so the plan reconciles them too. (Lockfiles regenerate; commit them in sync.)

3. **Recommend the build-time-stamp-without-commit + guard hybrid lean toward the guard for the committed-version case.** Both options are AC-permitted. Recommendation for the plan: keep the version **committed** (the four+ literals stay in the repo, reconciled), and add a **guard step in the release workflow** that fails when `${GITHUB_REF_NAME#v}` ≠ the committed canonical version. Rationale: (a) it directly satisfies the "fail the release on tag/version mismatch" edge case; (b) it avoids in-CI file mutation + the risk of accidentally committing churn back to main; (c) committed versions keep `npm run typecheck`/dev builds honest without CI. The final call (and which single file is the canonical comparison source — likely root `package.json`) is the plan's to make, but this story's contract must pin it so 002/003 can read the same value.

4. **Pick root `package.json` `version` as the canonical comparison source for the guard.** It is the repo-level version, already `0.2.0`, and trivially machine-readable (`jq -r .version package.json` / `node -p`). The guard reads it and compares to the stripped tag. This is documented in the contract as "where the version lives."

5. **Server `GET /` version: reconcile the literal to `0.2.0` for now (do not refactor to read package.json).** Reading `package.json` at runtime in the ESM/Docker build adds import-assertion/`fs` complexity and a path concern (dist vs src), for a single low-value field. A reconciled literal matches the existing pattern and is the lowest-risk change. The plan may revisit if it wants true single-source, but the simpler call honors "reduce the spots a human edits" without new machinery. (Flag in plan as a judgment call.)

6. **Contract file path = `contracts/versioning.md`** per the story frontmatter `provides_contract: contracts/versioning.md`, following the established `<story>/contracts/<name>.md` layout.

## Open Questions

None that block planning. The one genuine fork — build-time stamp vs committed-version guard — is explicitly allowed by the AC ("either ... or ...") and is a plan-level decision; Decision 3 documents the recommended path and rationale, and either choice produces a contract stories 002/003 can consume.
