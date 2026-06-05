#contract

# Contract: Published server image (M5 story 002)

Authoritative description of the server OCI image published by the M5 release
pipeline. **Story 004 (production compose that pulls this image) and story 005
(deployment/release docs) implement against exactly this** — the image
reference, tags, architecture, pull/run commands, and package-visibility notes
below are the single source of truth. Do not re-derive a different image name.

The version segment of the image tags is inherited from the upstream versioning
contract (`../../story-001-release-versioning/contracts/versioning.md`): it is
always `<version> = ${GITHUB_REF_NAME#v}` for the `v*` tag being released, which
(once `release-version-guard` passes) equals the committed root `package.json`
`.version`.

---

## Image reference

The full published image name is:

```
ghcr.io/tdmiller1/discord-clone-server
```

Broken down:

| Part       | Value                    | Notes                                            |
| ---------- | ------------------------ | ------------------------------------------------ |
| registry   | `ghcr.io`                | GitHub Container Registry                         |
| namespace  | `tdmiller1`              | repo owner (from `git remote`); already lowercase |
| repository | `discord-clone-server`   | the server image                                 |

GHCR requires the path to be all-lowercase; `tdmiller1` already satisfies this,
so the name is used as a literal with no lowercasing step.

## Tags published

Every `v*` release pushes **two** tags to the image above:

```
ghcr.io/tdmiller1/discord-clone-server:<version>     # e.g. :0.2.0 — the released version
ghcr.io/tdmiller1/discord-clone-server:latest        # moves to the newest released version
```

- `:<version>` — the specific release, where `<version> = ${GITHUB_REF_NAME#v}`
  (e.g. tag `v0.2.0` → `:0.2.0`). Treat as the immutable, pin-this-in-prod tag.
- `:latest` — re-pointed to the most recently released `<version>` on each
  release. Convenience tag; not a substitute for pinning `:<version>` in prod.

## Supported architecture

```
linux/amd64, glibc (Debian bookworm)  ONLY
```

The image is **amd64/glibc only — NOT arm64, NOT musl/alpine**. This is a hard
runtime constraint, not a packaging convenience:

- mediasoup's worker is a glibc-linked native binary (SPEC.md §11) and will not
  run under musl.
- `better-sqlite3` is compiled from source for the image's Node ABI.

The image is built on the amd64 `ubuntu-latest` runner with the default platform
(no `--platform`/buildx/multi-arch). Pulling it on an arm64 host will not run.

## Pull & run (serves `/health`)

Minimal pull + run that the release-verification step exercises:

```sh
docker pull ghcr.io/tdmiller1/discord-clone-server:<version>
docker run --rm -p 8080:8080 ghcr.io/tdmiller1/discord-clone-server:<version>
# then, from the host:
curl -sf http://127.0.0.1:8080/health
```

The image `EXPOSE`s `8080`, declares `VOLUME /data`, and ships a `HEALTHCHECK`
that hits `/health`. A full deployment (story 004) additionally maps the UDP RTC
media range and mounts the data volume, e.g.:

```sh
docker run -d \
  -p 8080:8080 \
  -p 40000-40010:40000-40010/udp \
  -v discord-clone-data:/data \
  -e PUBLIC_HOST=<your-host> \
  ghcr.io/tdmiller1/discord-clone-server:<version>
```

(The exact UDP range must match the server's `RTC_MIN_PORT`–`RTC_MAX_PORT`
config; story 004 owns the production compose that fixes these values.)

## Package visibility

GHCR packages default to **PRIVATE** on first publish. The publish workflow can
*push* (via the workflow `GITHUB_TOKEN` with `packages: write`) but **cannot
change package visibility** — visibility is a GHCR settings action, not a build
step. Stories 004/005 must surface one of these two paths in the runbook:

- **Make it public (anonymous pull):** in GitHub →
  Profile/Org → Packages → `discord-clone-server` → Package settings →
  Danger Zone → Change visibility → **Public**. After this, both
  `:<version>` and `:latest` are pullable with no authentication.
- **Keep it private:** the deploy host must authenticate before pulling:
  ```sh
  echo "<PAT-with-read:packages>" | docker login ghcr.io -u tdmiller1 --password-stdin
  ```
  using a Personal Access Token (classic) or fine-grained token that grants
  `read:packages` on this package.

## Idempotency

Re-running the release workflow for an existing tag (or re-pushing the same
`v<version>` tag) simply re-pushes — registry push is overwrite-by-tag, so
`:<version>` and `:latest` are overwritten predictably with **no "already
exists" failure**. The release is safe to re-run.

## Build provenance

- Built from the repo's existing multi-stage `server/Dockerfile` (`runtime`
  stage), build context `server/`, on `ubuntu-latest`.
- No second Dockerfile, no multi-arch, no SBOM/image signing (explicit M5
  non-goals).
- Published by the additive, tag-gated `release-server-image` job in
  `.github/workflows/ci.yml` (`if: startsWith(github.ref, 'refs/tags/v')`,
  `needs: release-version-guard`), so a version-mismatched tag never publishes.
