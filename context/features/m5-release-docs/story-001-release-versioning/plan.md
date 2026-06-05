#plan

# Plan: Single source-of-truth version derived from the git tag

## Summary
Reconcile every drifted version literal in the repo up to the existing `0.2.0` so all version fields agree at rest, then establish a `vX.Y.Z` git-tag convention with a CI **guard** (on `push: tags: ['v*']`) that fails the release when the stripped tag (`${GITHUB_REF_NAME#v}`) does not match the committed canonical version in root `package.json`. The convention is recorded in the `contracts/versioning.md` artifact that stories 002/003/005 consume.

Decisions adopted from research (all from its "Decisions Made" section, treated as final): reconcile to `0.2.0` (no new bump); reconcile **all** drifted literals not just the four AC-named files; use the **committed-version + guard** path (not build-time mutation); canonical comparison source is root `package.json` `.version`; keep the server `GET /` version as a reconciled literal (no runtime `package.json` read). One judgment call I am making explicit: the guard lives as a small inline step in `.github/workflows/ci.yml` under a new tag-triggered `release-version-guard` job (no separate `release.yml` and no `scripts/check-version.sh`), because it is a single use site and stories 002/003 will extend the same release surface; the contract documents the canonical value and derivation so 002/003 can reuse it regardless of where their jobs land.

## Implementation Steps

### Step 1: Reconcile `tauri.conf.json` version to `0.2.0`
**File(s):** `client/src-tauri/tauri.conf.json`
**Action:** modify
**Description:** This is the load-bearing file `tauri build` stamps into the `.msi`/`.exe`/`.AppImage`/`.deb` filenames + metadata (story 003 consumes those names). It currently lags at `0.1.0`.
**Diff shape:**
- Change: line 4 `"version": "0.1.0"` → `"version": "0.2.0"`.

### Step 2: Reconcile the Tauri crate version in `Cargo.toml` to `0.2.0`
**File(s):** `client/src-tauri/Cargo.toml`
**Action:** modify
**Description:** The crate's own version literal (line 3) also lags at `0.1.0`; reconcile so "all version fields agree at rest" is literally true. Tauri prefers `tauri.conf.json` for bundling, so this is cosmetic for distribution but is a real drifted literal the AC covers.
**Diff shape:**
- Change: line 3 `version = "0.1.0"` → `version = "0.2.0"`.

### Step 3: Sync the `discord-clone` entry in `Cargo.lock` to `0.2.0`
**File(s):** `client/src-tauri/Cargo.lock`
**Action:** modify
**Description:** The lockfile mirrors `Cargo.toml`; the `discord-clone` package entry must match so CI's `cargo`/`tauri build` does not produce churn. **Only line 788 may change** — it is the entry immediately under `name = "discord-clone"`. The other `version = "0.1.0"` lines (788 is ours; 1964=`leb128fmt`, 4308=`vswhom`, 4853=`windows-threading`) belong to dependency crates and MUST NOT be touched. Preferred mechanism: run `cargo update -p discord-clone` (or any `cargo`/`tauri build`) in `client/src-tauri/` to regenerate it after Step 2; if the toolchain is unavailable, surgically edit only line 788.
**Diff shape:**
- Change: line 788 (the `name = "discord-clone"` package's) `version = "0.1.0"` → `version = "0.2.0"`. No other lines.

### Step 4: Reconcile the server `GET /` info-route version literal to `0.2.0`
**File(s):** `server/src/app.ts`
**Action:** modify
**Description:** Line 123 hardcodes `version: "0.1.0"` in the only runtime-visible version surface (the `GET /` `{ name, version, docs }` response). Reconcile the literal to `0.2.0`. Per research Decision 5, leave it as a literal (do not refactor to read `package.json` at runtime — that adds ESM import-assertion/`fs`/dist-vs-src complexity for a single low-value field). This keeps the change minimal and `npm run typecheck`-safe.
**Diff shape:**
- Change: line 123 `version: "0.1.0",` → `version: "0.2.0",`.

### Step 5: Add a tag-triggered version-guard job to CI
**File(s):** `.github/workflows/ci.yml`
**Action:** modify
**Description:** Add the release tag trigger and a guard job — **additive only**, the existing `server` and `client` per-change jobs stay untouched (feature constraint: do not weaken/delete the current gate). Add `push: tags: ['v*']` to the existing `on:` block, and a new job `release-version-guard` that runs only on tag pushes, reads the canonical version from root `package.json` (`node -p "require('./package.json').version"`), strips the leading `v` from the tag (`VERSION="${GITHUB_REF_NAME#v}"`), and **fails** (`exit 1`) with a clear message when they differ. This satisfies the "tag pushed without a version bump" edge case and pins the exact derivation 002/003 reuse. Add a job-level `if:` so it is a no-op on branch/PR runs (`if: startsWith(github.ref, 'refs/tags/v')`).
**Diff shape:**
- Add to `on:`: a `push.tags: ['v*']` entry (alongside the existing `branches: [main]` — both push filters coexist).
- Add: a new `release-version-guard` job:
  - `runs-on: ubuntu-latest`, `if: startsWith(github.ref, 'refs/tags/v')`
  - `actions/checkout@v4`
  - a step that computes `VERSION="${GITHUB_REF_NAME#v}"`, reads `COMMITTED=$(node -p "require('./package.json').version")`, and `if [ "$VERSION" != "$COMMITTED" ]; then echo "::error::tag $GITHUB_REF_NAME (=$VERSION) does not match committed version $COMMITTED"; exit 1; fi` else echoes a confirmation.
- Change: nothing removed.

### Step 6: Create the `contracts/versioning.md` contract artifact
**File(s):** `context/features/m5-release-docs/story-001-release-versioning/contracts/versioning.md`
**Action:** create
**Description:** The `provides_contract` artifact stories 002/003/005 depend on. Follow the established contract format (lead with `#contract`, `# Contract: <title> (M5 story 001)`, an opening paragraph naming the downstream consumers and what is fixed vs pass-through, then the concrete spec). Records: the `vX.Y.Z` tag scheme; the canonical place the version lives (root `package.json` `.version`); the exact `${GITHUB_REF_NAME#v}` derivation (strip leading `v`); the full inventory of reconciled literals; the guard behavior on mismatch (release fails); and the precise values 002/003 should emit (image tag `ghcr.io/tdmiller1/discord-clone-server:<version>` + `latest`; GitHub Release `v<version>` + installer asset versions from `tauri.conf.json`). Mirror `voice-protocol.md`'s structure.
**Diff shape:**
- Add: new file with the sections in "New Types / Schemas / Contracts" below.

## New Types / Schemas / Contracts

The contract artifact `contracts/versioning.md`. It introduces no code types — it fixes a derivation and a canonical source. Authoritative shape downstream stories rely on:

```
Canonical version source:
  root package.json  ->  .version  (string, semver "X.Y.Z")   # the single comparison source

Tag scheme:
  git tag = "v" + <version>           e.g.  v0.2.0
  release version derivation:
    VERSION = GITHUB_REF_NAME with leading "v" stripped   ( ${GITHUB_REF_NAME#v} )
    e.g.  v0.2.0  ->  0.2.0

Guard (release-version-guard job, on push tags: v*):
  committed = node -p "require('./package.json').version"
  if VERSION != committed  ->  release fails (exit 1)   # "tag pushed without a version bump"

Reconciled-at-rest literals (all == committed version, == 0.2.0 after this story):
  package.json .version
  server/package.json .version
  client/package.json .version
  client/src-tauri/tauri.conf.json .version    # load-bearing: stamps installer filenames
  client/src-tauri/Cargo.toml [package].version
  client/src-tauri/Cargo.lock  (discord-clone entry, regenerated)
  server/src/app.ts GET "/" -> { version }     # runtime-visible literal
  (package-lock.json x3 already 0.2.0; auto-derived)

Values downstream stories MUST derive from <version> (NOT re-maintain):
  story 002 image tags:  ghcr.io/tdmiller1/discord-clone-server:<version>  and  :latest
  story 003 release:     GitHub Release tag/name  v<version>
  story 003 installers:  versions come from tauri.conf.json (== <version>)
  story 005 docs:        reference the same  ...:<version>  / v<version>  names
```

## Configuration / Environment Changes
None. No new env vars, secrets, config keys, or persisted columns. The only "config" surface added is a CI workflow trigger (`push: tags: ['v*']`) and job, which read the existing `GITHUB_REF_NAME`/`GITHUB_TOKEN` GitHub-provided context (no secret to register). No change to `loadConfig()` / `server/.env.example`.

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| HTTP route (runtime, reconciled value) | `GET /` | none | `{ name: "discord-clone-server", version: "0.2.0", docs: "See SPEC.md" }` | Shape unchanged; only the `version` literal moves `0.1.0`→`0.2.0`. Unauthenticated info route. |
| CI trigger | `push: tags: ['v*']` in `ci.yml` | a pushed `v*` git tag | runs `release-version-guard` | Additive to existing `branches:[main]`/`pull_request`/`workflow_dispatch` triggers. |
| CI job (gate) | `release-version-guard` | `GITHUB_REF_NAME` (the tag), root `package.json` | pass / `exit 1` | Fails release when `${GITHUB_REF_NAME#v}` ≠ committed `.version`. No-op on non-tag refs via `if:`. |
| Contract artifact | `contracts/versioning.md` | — | the version/tag derivation spec | Consumed by stories 002, 003, 005. |

## Edge Cases & Gotchas

- **Tag pushed without a version bump** (the named feature edge case) — guard in Step 5 compares stripped tag to committed `.version` and fails the release.
- **`Cargo.lock` has multiple `0.1.0` entries** — only the `discord-clone` crate entry (line 788) is ours; `leb128fmt`/`vswhom`/`windows-threading` are deps and must not change. Addressed in Step 3 (prefer `cargo update -p discord-clone`; otherwise edit only line 788).
- **Guard must not run on branch/PR/dispatch** — Step 5 gates the job with `if: startsWith(github.ref, 'refs/tags/v')` so the per-change gate (server/client jobs) is unaffected and the guard is a no-op except on `v*` tags.
- **Two `push` filters coexisting** — adding `tags: ['v*']` next to `branches: [main]` under `on: push:` means push-to-main still triggers the existing jobs and tag pushes additionally trigger the guard; the existing jobs are not tag-gated, so they also run on the tag commit (acceptable — they are the same build, no weakening).
- **Don't introduce a new third place to maintain the version** (AC) — no new committed version literal is added; the contract file documents (not duplicates as an editable source) the value, and the guard *reads* the existing root `package.json` rather than holding its own copy.
- **`npm run typecheck` / client build must still pass** (AC) — Step 4 only changes a string literal (type-safe); Steps 1–3 keep `tauri.conf.json` valid JSON and `Cargo.toml`/`Cargo.lock` in sync so `tauri build` still works. Verify with `npm run typecheck` after Step 4.
- **Server `GET /` left as a literal** — judgment call (research Decision 5): a runtime `package.json` read in ESM/Docker adds dist-vs-src + import-assertion risk for a one-field benefit; reconciling the literal is the lowest-risk way to honor "reduce the spots a human edits."
- **No git tags exist yet** — the `v0.2.0` convention is established fresh; the first release tag will be `v0.2.0` matching the now-reconciled committed version (so the guard passes on first use).
- **Owner is `tdmiller1`** (from `git remote`) — the image-name example in the contract uses `ghcr.io/tdmiller1/...`; story 002 owns the final image name but the contract pins the derivation.

## Acceptance Criteria Checklist

- [ ] Drift resolved — `tauri.conf.json` reconciled to agree with the three `package.json` (all `0.2.0`) → Step 1 (plus Steps 2–4 cover the additional drifted literals so **all** fields agree).
- [ ] Documented tag → version convention (`vX.Y.Z` is source of truth; image/Release/installer versions derive from it via strip-leading-`v`) with a concrete mechanism (guard) → Step 5, Step 6.
- [ ] If version is committed, a guard fails the release on tag/committed mismatch (covers "tag pushed without a version bump") → Step 5.
- [ ] No new third place to maintain the version; the convention reduces the human-edited spots → Steps 1–4 (reconcile, no new literal added) + Step 5 (guard reads existing root `package.json`, holds no copy).
- [ ] `npm run typecheck` still passes; `tauri.conf.json` remains valid / client still builds → Steps 1–4 (literal/JSON/TOML-safe changes; verify post-Step 4).
- [ ] `contracts/versioning.md` records the tag scheme, where the version lives, the exact tag→version derivation, and the guard mismatch behavior for stories 002/003/005 → Step 6.
