#contract

# Contract: Release assets — GitHub Release tag, URL, and installer filenames (M5 story 003)

Authoritative description of the **GitHub Release** produced on a `v*` tag push and the
**client installer assets** attached to it. **Story 005 (deployment/release docs) implements
its download/install instructions against exactly this.** It fixes the Release tag/name
scheme, the canonical Release URL, the exact per-OS installer asset filenames (with
`<version>` substitution), and the "release fails if an installer is missing" guarantee.

The version is **not** re-maintained here — it derives from the upstream versioning contract
(`story-001-release-versioning/contracts/versioning.md`). This contract only documents the
artifact-naming and Release surface downstream prose links against.

---

## `<version>` derivation

```sh
VERSION="${GITHUB_REF_NAME#v}"   # v0.2.0 -> 0.2.0
```

`<version>` is the pushed git tag with the single leading `v` stripped, and equals the
committed root `package.json` `.version` (enforced by story 001's `release-version-guard`
job, which runs on the same `v*` trigger and fails the release on a tag≠committed mismatch
before any installers publish). See `versioning.md` for the canonical rule. Current
committed version: `0.2.0`.

## Release tag / name

The GitHub Release is created (or reused) for the pushed git tag. Its **tag** and **display
name** are the tag name itself:

```
v<version>        e.g.  v0.2.0
```

In CI this is supplied as the `tag_name: ${{ github.ref_name }}` input to
`softprops/action-gh-release@v2`.

## Release URL

```
https://github.com/tdmiller1/discord-clone/releases/tag/v<version>
```

e.g. `https://github.com/tdmiller1/discord-clone/releases/tag/v0.2.0`

Latest-release shortcut (always resolves to the newest published Release):

```
https://github.com/tdmiller1/discord-clone/releases/latest
```

Direct per-asset download URL pattern (for deep links in docs):

```
https://github.com/tdmiller1/discord-clone/releases/download/v<version>/<asset-filename>
```

## Published assets (exactly four — two per OS)

`tauri build` stamps these names from `client/src-tauri/tauri.conf.json`
`productName` (`discord-clone`) + `version` (`<version>`). CI uploads them via version-agnostic
globs, so the names track `<version>` automatically without a CI edit.

| OS | Format | Asset filename | Install action |
| --- | --- | --- | --- |
| Windows | MSI installer | `discord-clone_<version>_x64_en-US.msi` | double-click to install |
| Windows | NSIS setup `.exe` | `discord-clone_<version>_x64-setup.exe` | double-click to install |
| Linux | AppImage (portable) | `discord-clone_<version>_amd64.AppImage` | `chmod +x` then run directly |
| Linux | Debian package | `discord-clone_<version>_amd64.deb` | `sudo apt install ./<file>.deb` |

Concrete example for `v0.2.0`:

```
discord-clone_0.2.0_x64_en-US.msi
discord-clone_0.2.0_x64-setup.exe
discord-clone_0.2.0_amd64.AppImage
discord-clone_0.2.0_amd64.deb
```

## Architecture / platform scope

- **amd64 / x64 only** — arm64 is a feature non-goal.
- **No macOS assets** — feature non-goal (Windows + Linux only).

## Signing

Installers are **unsigned**. Expect a Windows SmartScreen ("Windows protected your PC")
warning and a Linux "untrusted AppImage" prompt — these are normal and the install must be
explicitly allowed. (Story 005 documents the user-facing warning and the click-through.)

## Missing-installer guarantee

The Release-upload step sets `fail_on_unmatched_files: true`. If a matrix leg fails to
produce any one of its expected installer formats, the workflow **fails** and **no partial
Release** with a missing OS installer is published. A successfully published Release for
`v<version>` therefore always carries all four assets above.

## Idempotency

Re-running the workflow for an existing tag **updates the same Release** and **clobbers
same-named assets** (no "release already exists" crash, no duplicate assets). Both matrix
legs (ubuntu, windows) target the same `tag_name`; the action merges each leg's two assets
into the single Release for that tag.
