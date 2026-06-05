#contract

# Contract: Release versioning — tag → version derivation (M5 story 001)

Authoritative versioning contract for the M5 release pipeline. **Story 002 (image
publish), story 003 (GitHub Release + installer upload), and story 005 (deployment/release
docs) implement against exactly this.** It fixes a single source of truth for the project
version, the `vX.Y.Z` git-tag scheme, the exact tag→version derivation, the inventory of
reconciled-at-rest version literals, and the release guard that fails when a pushed tag does
not match the committed version.

There is **no new committed place to maintain the version**: the canonical source is the
existing root `package.json` `.version`. Every other version literal is reconciled to it and
kept in sync at rest; the guard *reads* the canonical source rather than holding its own copy.
Downstream stories **derive** their artifact names from `<version>` — they do not re-maintain
a separate version literal.

---

## Canonical version source

The single comparison source is the repo-root `package.json` `.version` field (semver
`X.Y.Z`, currently `0.2.0`).

```sh
COMMITTED=$(node -p "require('./package.json').version")   # e.g. 0.2.0
```

This is "where the version lives" for the purpose of the guard and all downstream derivation.

## Tag scheme

A release is cut by pushing a git tag of the form `v` + `<version>`:

```
git tag = "v" + <version>        e.g.  v0.2.0
```

No git tags existed before this story; the convention is established fresh and the first
release tag is `v0.2.0` (matching the now-reconciled committed version).

## Tag → version derivation (THE canonical rule)

The release version is the tag name with the leading `v` stripped. In CI this is a shell
parameter expansion over the GitHub-provided `GITHUB_REF_NAME`:

```sh
VERSION="${GITHUB_REF_NAME#v}"   # v0.2.0 -> 0.2.0
```

Downstream stories MUST use this exact derivation (strip a single leading `v`) so the image
tag, Release name, and installer versions all resolve to the same `<version>`.

## Release guard behavior (on mismatch)

A tag-triggered CI job `release-version-guard` (in `.github/workflows/ci.yml`) enforces the
contract. It runs **only** on `v*` tag pushes (`if: startsWith(github.ref, 'refs/tags/v')`)
and is a no-op on branch/PR/dispatch runs, so the existing per-change `server` and `client`
gate jobs are unaffected.

```sh
VERSION="${GITHUB_REF_NAME#v}"
COMMITTED=$(node -p "require('./package.json').version")
if [ "$VERSION" != "$COMMITTED" ]; then
  echo "::error::tag $GITHUB_REF_NAME (=$VERSION) does not match committed version $COMMITTED"
  exit 1   # release fails — "tag pushed without a version bump"
fi
```

- On match: the guard passes and the release may proceed.
- On mismatch: the guard fails (`exit 1`), failing the release. This is the "tag pushed
  without a version bump" edge case.

CI trigger surface (additive to the existing `branches: [main]` / `pull_request` /
`workflow_dispatch`):

```yaml
on:
  push:
    branches: [main]
    tags: ['v*']
```

## Reconciled-at-rest literals

After this story, **every** version literal in the repo equals the canonical version
(`== root package.json .version == 0.2.0`). The full inventory:

```
package.json                            .version                         # CANONICAL source
server/package.json                     .version
client/package.json                     .version
client/src-tauri/tauri.conf.json        .version    # load-bearing: stamps installer filenames
client/src-tauri/Cargo.toml             [package].version
client/src-tauri/Cargo.lock             discord-clone package entry      # mirrors Cargo.toml
server/src/app.ts                       GET "/" -> { version }           # runtime-visible literal
package-lock.json (root/server/client)  "version"                        # auto-derived, in sync
```

Notes:
- `tauri.conf.json` `.version` is the value `tauri build` stamps into the
  `.msi`/`.exe`/`.AppImage`/`.deb` filenames + metadata; it is the load-bearing file for
  installer versions (story 003 consumes those names). `Cargo.toml`/`Cargo.lock` are the
  crate's own version (cosmetic for distribution but reconciled so all fields agree).
- `server/src/app.ts` `GET /` returns `{ name: "discord-clone-server", version: "0.2.0",
  docs: "See SPEC.md" }` — the only runtime-visible version surface. Kept as a reconciled
  literal (not a runtime `package.json` read) to avoid ESM/Docker `fs`/dist-vs-src risk.

## Values downstream stories MUST derive from `<version>` (NOT re-maintain)

```
story 002  image tags:   ghcr.io/tdmiller1/discord-clone-server:<version>   and   :latest
story 003  release:      GitHub Release tag/name   v<version>
story 003  installers:   versions come from tauri.conf.json (== <version>); tauri build stamps
                         them into the .msi/.exe/.AppImage/.deb filenames + metadata
story 005  docs:         reference the same  ...:<version>  /  v<version>  names
```

Here `<version>` is always `${GITHUB_REF_NAME#v}` for the tag being released (and equals the
committed root `package.json` `.version` once the guard passes). The repo owner is `tdmiller1`
(from `git remote`); story 002 owns the final image name, but the registry path and `:latest`
companion tag derive from this contract.
