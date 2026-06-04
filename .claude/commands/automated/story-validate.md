You are validating a completed user story against its acceptance criteria and creating a DONE marker if it passes.

Story directory: $ARGUMENTS

## Step 1 — Read all artifacts

Read the following files. If the `*_story.md` file or `plan.md` are missing, tell the user and stop.

- `$ARGUMENTS/<basename-of-ARGUMENTS>_story.md` — the acceptance criteria to validate against
- `$ARGUMENTS/plan.md` — the implementation checklist (verify steps were followed) and the edge-cases section
- `$ARGUMENTS/research.md` — for context on files touched and existing patterns

## Step 2 — Run available checks (report only)

Run whatever checks this project provides and that are appropriate for the changes made — typecheck, tests, and lint. Discover the commands from the repo (package.json scripts, Makefile, pyproject/tox, CI config) rather than assuming.

<!-- PROJECT-SPECIFIC: pin the exact commands once known so validation is
     deterministic, e.g.
       npm run typecheck   /  npm test   /  npm run lint
       python -m pytest
     Adjust working directories for monorepos. -->

Report pass/fail for each. **Do not attempt to fix failures here** — passing checks is the implementer's responsibility (Step 4 of `story-implement`). If any check fails, the story is not ready: record the failure, mark validation as FAIL in Step 6, do not write DONE.

## Step 3 — Validate acceptance criteria

For each criterion in the `*_story.md` file, evaluate whether it is satisfied:

- **PASS** — the implementation clearly satisfies the criterion (cite the file/line)
- **FAIL** — the implementation does not satisfy the criterion (explain what's missing)
- **UNTESTABLE** — cannot verify automatically; requires manual testing (describe what to do)

Print a table:

| Criterion | Status | Notes |
|-----------|--------|-------|
| <criterion> | PASS / FAIL / UNTESTABLE | <detail> |

## Step 4 — Check implementation quality

Verify the implementation against this project's standards.

<!-- PROJECT-SPECIFIC: list the concrete quality gates for this repo and keep them
     in sync with the hard rules in story-implement, so implement and validate
     agree. Examples: styling conventions honored, no disallowed types, shared
     types/hooks placed correctly, required helper used instead of hand-rolling. -->

- [ ] The change honors the hard rules declared in `story-implement`
- [ ] No leftover TODO comments or placeholder text
- [ ] No files over 1000 lines

## Step 5 — Documentation audit

Inspect the files changed in this story (use `git diff --name-only main...HEAD -- $ARGUMENTS` plus any code changes) and identify which docs must be updated. Only list docs that genuinely need changes for this story — do not churn unrelated sections.

<!-- PROJECT-SPECIFIC: list this repo's architecture/reference docs (e.g. system
     overview, service/component design, schema diagram, README). If the project
     keeps no such docs, delete this whole section. -->

| File | Section | What Changes | Updated? |
|------|---------|--------------|----------|
| <doc path> | <section> | <what changes> | ✅ / ⚠️ missing |

If a required doc update is missing, mark the validate result as FAIL and list the missing updates for the implementer to address.

## Step 6 — Decision

**If all criteria PASS or UNTESTABLE and quality checks pass:**

1. Create `$ARGUMENTS/DONE` with content:
```
Validated: <today's date>
Branch: <current git branch>

Acceptance Criteria:
<copy the criterion table here>

Suggested commit message:
<see below>
```

2. Suggest a commit message following conventional commits format:
```
feat(<scope>): <short description>

<body: what was done and why, 2-3 sentences>

Story: $ARGUMENTS
```

3. Tell the user the story is complete and suggest next steps (next story or open a PR).

**If any criteria FAIL:**

List what needs to be fixed and tell the user to re-run `/story-implement $ARGUMENTS` after addressing the gaps. Do not create the DONE file.
