You are validating a completed feature — auditing that every story is DONE, syncing the feature spec with reality, running project-wide checks, auditing the docs the feature should have touched, bumping the package version, and flipping the feature's status to `done` if everything passes.

Feature directory: $ARGUMENTS (expected: `context/features/<slug>`)

## Step 1 — Read the feature spec

Read `$ARGUMENTS/<basename-of-ARGUMENTS>_feature.md`. If it does not exist, tell the user and stop.

Extract from the frontmatter:
- `name` — human-readable feature name
- `status` — current status (should be `in-progress` or `planned`)
- `tags` — if present, look for a `status/*` tag that will need flipping (vault repos only)

Extract from the body:
- The `## User Stories` table — note each row's Story Directory and its current Status value (TODO / IN PROGRESS / COMPLETE)

## Step 2 — Audit DONE markers

List every direct subdirectory of `$ARGUMENTS/` that starts with `story-` (ignore other nested content).

For each story dir, check whether a `DONE` file exists.

- A `DONE` marker (even a manually created one, regardless of contents) means the story is **complete**. Do not try to validate stories without a DONE by running `/story-validate` inline — that is the user's explicit call to make before running this command.
- If any story dir has no `DONE`, **stop here**. Print a table of each story with its DONE status, list the ones missing DONE, and tell the user to either run `/story-validate <story-dir>` for each or `touch $ARGUMENTS/<story-dir>/DONE` if they are manually attesting completeness. Do not modify any files.

Also reconcile with the feature spec's story table: if the table lists a story dir that doesn't exist on disk, or the disk has a story dir not in the table, flag the drift and stop — this is a spec integrity issue the human should resolve.

## Step 3 — Sync the story status table

Every story dir has a DONE marker at this point. Edit the `## User Stories` table in the `_feature.md` so every row's Status column reads `COMPLETE`. Use the Edit tool, not Write — preserve the rest of the file verbatim.

## Step 4 — Run project-wide checks

Run whatever checks are appropriate for this feature's surfaces. **Discover the commands from the repo** (package.json scripts, Makefile, pyproject/tox, CI config) rather than assuming a layout. Typically: typecheck, tests, lint — run each that applies, adjusting working directories for monorepos.

Report the output of each. If any fail, stop — do not flip status. Tell the user to fix the failures and re-run. Do not attempt to fix test failures from this command; that's outside its scope.

## Step 5 — Docs audit

This is the "did we actually update the docs the feature said it would" pass. Skip this entire step if the repo keeps no architecture/reference docs.

### Step 5a — Aggregate per-story doc claims

For each story dir, read `research.md` / `plan.md` if present and extract any "Documentation" section listing docs the story claimed it would touch. Build a consolidated set of those doc paths (architecture docs, README, schema diagrams, ADRs, CLAUDE.md, etc.). Ignore claims that say "no changes" for a given doc.

### Step 5b — Determine the feature branch point

Find the commit that introduced the feature spec file:

```bash
git log --follow --diff-filter=A --format=%H -- "$ARGUMENTS/<basename>_feature.md" | tail -1
```

Call that `$BASE`. If it returns empty (spec created outside git), fall back to `git merge-base main HEAD` (or the repo's default branch) and warn the user the diff window may be wider than the feature's actual scope.

### Step 5c — Run the diff

Check which of the claimed docs (plus any docs directories this repo uses) were modified between `$BASE` and `HEAD`:

```bash
git diff --name-only "$BASE"..HEAD -- <doc paths this repo uses>
```

Produce a report table:

| Doc | Claimed by stories? | Modified in feature branch? | Action |
|---|---|---|---|
| `<doc>` | yes | yes | ✓ OK |
| `<doc>` | yes | no | ⚠️ Flagged by research but not updated — review before marking done |
| `<doc>` | no | yes | ⚠️ Modified but not flagged — undocumented change |

### Step 5d — Verification-date bump candidates (if the repo uses one)

If this repo's docs/ADRs carry a `last_verified:` (or similar) frontmatter convention, print a reminder for any such doc that shows up modified in the diff: "Feature delivery implies these docs were re-read end-to-end. If so, bump the verification date in their frontmatter." Do **not** auto-bump — the date tracks verification, not modification, so the human makes the call. If the repo has no such convention, skip this step.

### Step 5e — Advisory surfacing

Scan the feature diff for signals and print any that match, as prompts (not actions). Adapt these categories to this repo's layout:

- New/modified DB migrations or schema files → "Schema change detected; consider a new ADR or schema-doc update."
- New/modified Dockerfiles, infra templates, or deploy workflows → "Infra/deploy change detected; consider an ADR and a deployment-doc review."
- New top-level routes, pages, jobs, or public entry points → "Candidate additions to the CLAUDE.md / quick-reference docs."
- The feature dir's `related:` frontmatter lists other features → "Check whether related features' `_feature.md` need cross-link updates."

These are reminders only. Do not edit the target files.

### Step 5f — Human decision gate

If Step 5c surfaced any ⚠️ rows, surface the full report and ask the user: "Docs drift detected — proceed with status flip anyway, or pause here?" Wait for their answer. `/feature-validate` does not block on docs drift — it just refuses to silently ignore it.

If the user says pause, stop without flipping status. If they say proceed, continue to Step 6.

## Step 6 — Flip status to done

At this point: all stories have DONE markers, the story table is synced, checks pass, and the docs audit has been surfaced (and acknowledged).

Edit `$ARGUMENTS/<basename>_feature.md`:

- In the frontmatter, change `status: in-progress` (or `planned`) → `status: done`.
- In the frontmatter, add `completed_date: <today's date, YYYY-MM-DD>` directly under the `status:` line. If it already exists (re-running after a fix), overwrite it with today's date.
- If the frontmatter has a `tags:` array (vault repos), change `- status/in-progress` → `- status/done`.

Use the Edit tool. Preserve every other field verbatim.

(Vault repos: `completed_date` feeds the `CompletedFeatures` Bases view. Archive convention — features completed long ago are archive candidates; manually move `context/features/<slug>/` under `context/features/_archive/<slug>/` when done referencing them. This command only stamps the date; it does not archive.)

## Step 7 — Bump the package version

A completed feature ships new functionality, so bump the project's package version. This step runs only after every gate above has passed (you reached Step 6).

### Step 7a — Discover package manifests

Find the version-bearing `package.json` files this repo actually tracks — do not assume a layout:

```bash
git ls-files '*package.json' ':!:**/node_modules/**' | xargs -r -I{} dirname {} | sort -u
```

- If the repo has **no** tracked `package.json` (a non-Node project), skip the rest of this step and note "no package.json — version bump skipped" in the report.
- This command only bumps `package.json`. If you notice other version manifests in the diff (`Cargo.toml`, `pyproject.toml`, a `VERSION` file, `tauri.conf.json`'s `version`), do **not** edit them — list them as a reminder so the human can bump them to match.

### Step 7b — Ask for the bump level

Read and print the current `version` from each discovered `package.json`, then ask the user which semver bump to apply: **patch**, **minor**, or **major**. Recommend **minor** (a completed feature is typically new backward-compatible functionality), but do not assume — wait for their answer before editing anything. If the user has already stated a level for this run, use it without re-asking.

### Step 7c — Apply the bump

Apply the chosen level to the `version` field of each discovered `package.json`. In repos whose packages share one version (the common case — e.g. a root + `server/` + `client/` all at the same version), bump them all to the same new version so they stay in sync; if the repo versions packages independently, bump each to its own next version. Prefer, run once per package directory:

```bash
npm version <level> --no-git-tag-version --allow-same-version
```

`--no-git-tag-version` rewrites `version` (and `package-lock.json` when present) **without** creating a git commit or tag and without requiring a clean working tree; `--allow-same-version` keeps re-runs idempotent. Do **not** commit or tag — `/feature-validate` leaves staging and commits to the human's PR, exactly as it does for the status flip.

Record each manifest's old → new version for the DONE marker and the final report.

## Step 8 — Write the feature-level DONE

Create `$ARGUMENTS/DONE` (no extension, same convention as story-level DONE):

```
Feature: <name from frontmatter>
Validated: <today's date>
Branch: <current git branch>

Stories:
<one bullet per story — "- story-NNN-<slug> ✓">

Project-wide checks:
<summary of the commands you ran in Step 4 and their pass/fail>

Version bump:
<level applied, and each manifest's old → new version; or "skipped — no package.json">

Docs audit:
<paste the table from Step 5c, and any advisories from Step 5e that apply>

Suggested PR title:
feat(<slug>): <one-line summary>

Suggested PR body:
<2-3 sentence summary of what the feature delivers, pulled from the _feature.md Goal section>

Next steps:
- Open the PR.
- Run /review and /security-review against the PR.
- (Vault repos) If `context/index.md` has a hand-curated "In Progress" entry for this feature, remove it.
- Bump any doc verification dates per Step 5d, and any non-package.json version manifests noted in Step 7a.
```

## Step 9 — Report

Print to the user:

1. Confirmation the feature is marked done (with the frontmatter diff).
2. The version bump applied (level + old → new per manifest), or that it was skipped.
3. The path to the new `DONE` marker.
4. The suggested PR title + body.
5. The follow-up list from the DONE marker's "Next steps" block.

## Guardrails

- Never flip status if any story lacks a DONE marker. Always stop and surface the missing ones.
- Never flip status if project-wide checks fail. Always stop and surface the failures.
- Never bump the version before every gate has passed — the bump is part of the finalize block (Steps 6–8), so a run that stops early must not touch any `package.json`.
- Never commit or tag the version bump — leave it staged for the human's PR.
- Never auto-edit docs, README, schema diagrams, ADRs, or CLAUDE.md — docs drift is surfaced for human judgment.
- Never auto-bump verification dates — the convention is verification, not modification.
- Never edit non-`package.json` version manifests (`Cargo.toml`, `pyproject.toml`, `tauri.conf.json`, etc.) — surface them as reminders only.
- (Vault repos) Never auto-edit `context/index.md` — the hand-curated lists are editorial.
- If you stop at any gate (missing DONE, failing checks, docs drift the user pauses on), leave the feature spec and all other files unmodified. A failed `/feature-validate` must be a no-op on disk.
