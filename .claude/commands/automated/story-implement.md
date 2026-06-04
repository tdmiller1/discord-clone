You are implementing a user story by executing its plan exactly as written.

Story directory: $ARGUMENTS

## Step 1 — Read all artifacts

Read ALL of the following. If any are missing, tell the user which file is missing and stop.

- `$ARGUMENTS/<basename-of-ARGUMENTS>_story.md` — acceptance criteria (your definition of done)
- `$ARGUMENTS/research.md` — patterns and gotchas to follow
- `$ARGUMENTS/plan.md` — the implementation checklist to execute

## Step 2 — Execute the plan

Work through each step in `plan.md` in order. For each step:

1. Read the target file(s) before editing them (never edit blind).
2. Make the change described. Follow the patterns from `research.md` exactly — do not invent new patterns.
3. After completing each step, mark it done. Do not skip steps or reorder them without noting why.

**Hard rules during implementation:**

<!-- PROJECT-SPECIFIC: replace the bullets below with this project's non-negotiable
     conventions — the rules the implementer must never violate. Encode the kinds
     of things your CLAUDE.md / style guide enforces, e.g.:
       - layering / where data access is allowed to live
       - styling conventions
       - typing strictness and where shared types live
       - naming patterns for new modules, hooks, endpoints, or jobs
       - modules that must not be extended further (extract instead)
       - which shared helper must be used instead of hand-rolling (fetch, ids, etc.)
     Keep the list tight; this is the contract, not a full style guide. Delete the
     examples once you've filled in the real rules. -->

- Follow the existing patterns captured in `research.md` exactly — do not invent new ones.
- Keep files under 1000 lines; prefer extracting a helper over growing a file.
- Do not add comments, docstrings, or type annotations to code you didn't touch.

## Step 3 — Emit downstream contract

If this story declares a downstream contract, you MUST write it before reporting completion. The workflow asserts the file exists and will fail the wave if it is missing.

Provides contract: $PROVIDES_CONTRACT

If the value above is "(none)", this story has no downstream consumers and you can skip this step. Otherwise, write the file at the path indicated, relative to `$ARGUMENTS/`. The contract should document the exact, stable interface downstream stories will consume — for an API route, the URL/method/payload/response schema; for a function, the signature and return shape; for a data record, the field names and types; for a UI component, its props and emitted events. Be concrete and copy-pasteable: downstream research will treat this file as authoritative.

## Step 4 — Self-review

After all steps are complete, re-read each modified file and verify:

- [ ] The change follows the project's hard rules listed in Step 2
- [ ] No leftover placeholder text, TODOs, or debug output
- [ ] All acceptance criteria from the `*_story.md` file are plausibly satisfied
- [ ] The declared `provides_contract` file exists and matches the implementation (if applicable)

<!-- PROJECT-SPECIFIC: add concrete review checks that mirror the hard rules above
     (e.g. "no inline styles", "no `any` types", "new shared types registered in
     the shared types file"). -->

If you find issues, fix them now.

## Step 5 — Report

Summarize:
1. What was implemented (one sentence per step)
2. Any deviations from `plan.md` and why
3. Check results — run whatever typecheck / tests / lint this project provides, and report pass/fail and what you fixed
4. Any acceptance criteria you could not satisfy and why
