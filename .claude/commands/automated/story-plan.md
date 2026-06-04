You are creating a detailed implementation plan for a user story. No code is written yet — this is design only.

Story directory: $ARGUMENTS

## Step 1 — Read all inputs

Read the following files. If the `*_story.md` file or `research.md` are missing, tell the user and stop.

- `$ARGUMENTS/<basename-of-ARGUMENTS>_story.md` — the user story and acceptance criteria
- `$ARGUMENTS/research.md` — codebase research, files to touch, patterns, open questions
- The parent `_feature.md` if it exists

If `research.md` contains a "Decisions Made" section, treat those decisions as final. If it contains an "Open Questions" section, resolve each question yourself using the best answer derivable from existing codebase patterns — document your choice in the plan's Summary. Only stop if a question is a genuine external blocker (e.g. a missing secret that cannot be inferred from any existing code).

## Step 2 — Read key files

Read the files listed under "Likely Modified" and "Likely Created" in `research.md` to understand their current state. Also read the reference files to internalize the patterns.

## Step 3 — Produce plan.md

Write `$ARGUMENTS/plan.md` with this structure:

````
#plan

# Plan: <Story title>

## Summary
<1–2 sentence description of what will be built and how>

## Implementation Steps

Each step should be small enough to be a single logical change. Order them so each step builds on the previous.

### Step 1: <title>
**File(s):** `path/to/file`
**Action:** create | modify | delete
**Description:** <what exactly changes and why>
**Diff shape:**
- Add: <what is added>
- Remove: <what is removed>
- Change: <what is changed>

### Step 2: <title>
...

## New Types / Schemas / Contracts

List any new types, models, dataclasses, schemas, or data shapes introduced. Be concrete — downstream stories will treat this as authoritative. Show the shape in this project's language:

```
// example — adapt to this project's language and conventions
SomeContract {
  field: type
}
```

## Configuration / Environment Changes

<!-- PROJECT-SPECIFIC: describe how this repo wires new config / env vars / secrets,
     and where each must be registered for local + deployed environments. Replace
     this comment with the real steps for this project; if the project has no such
     wiring, write "None" and delete the comment. -->

List any new environment variables, secrets, config keys, or persisted columns/fields this story introduces, with each one's default and where it must be registered.

## API / Interface Changes

If any externally-consumed surface is added or modified (HTTP route, RPC, CLI flag, persisted schema, public function), document it concretely:

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| <kind>  | <name/path>| <shape>         | <shape>           | <auth, defaults, etc.> |

## Edge Cases & Gotchas

As you design the steps, enumerate edge cases the implementation must handle. Think about: auth/permissions, empty states, error and partial-failure states, retries/idempotency, concurrent writes, interrupted or resumed work, and mode/flag variations. For each, note which step addresses it.

- <edge case> — handled in Step N
- ...

## Acceptance Criteria Checklist

Map each criterion from the `*_story.md` file to the step(s) that satisfy it:

- [ ] <criterion> → Step N
- [ ] <criterion> → Step N, Step M
````

## Step 4 — Summarize

After writing `plan.md`, print the implementation steps as a numbered list. Note any decisions you made that weren't explicit in the story. Do not ask the user to confirm — the pipeline proceeds automatically.
