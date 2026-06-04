You are performing research for a user story before any implementation begins.

Story directory: $ARGUMENTS

## Step 0 — Required upstream contracts

You MUST read the following upstream contract files before doing anything else. They are the authoritative source for any shape, signature, or interface that earlier stories in this feature have already committed to. Treat their contents as fixed — your research and the resulting plan must conform to them.

$UPSTREAM_CONTRACTS

If the block above says "(none)", this story has no upstream dependencies and you can proceed without consuming any prior contracts.

## Step 1 — Read the story

Read the story file in `$ARGUMENTS/` — it is named `<basename-of-ARGUMENTS>_story.md` (e.g. if `$ARGUMENTS` is `context/features/foo/story-001-bar`, the file is `story-001-bar_story.md`). If it does not exist, tell the user and stop.

Also read the parent feature spec at `$ARGUMENTS/../<feature-name>_feature.md` (one level up — where `<feature-name>` is the name of the parent directory) if it exists.

## Step 2 — Explore the codebase

Based on the story's acceptance criteria and context, explore the codebase to find:

1. **Files you would likely touch** — search for the relevant modules, functions, data structures, and entry points this story implies. Use Grep and Glob to locate them. Read key files to understand current patterns.
2. **Existing patterns to follow** — how are similar things done today? Find the closest existing analogue to what this story asks for and note its structure (module layout, function/class shapes, naming, how it wires into the rest of the system) so the implementer can copy it.
3. **Data flow** — trace the relevant path through the stack for the domain this story touches: from the triggering action (request, job, CLI invocation, event) through the core logic to the data store and outputs, or vice versa.
4. **Open questions** — things you genuinely cannot determine from the code alone AND that have no clear answer derivable from existing patterns. The bar is high: if you can make a reasonable call by following existing conventions, make the call and document your rationale instead of asking.

Edge cases and documentation impact are deliberately *not* researched here — they are handled in the plan and validate phases respectively. Keep this phase tight.

## Step 3 — Write research.md

Write `$ARGUMENTS/research.md` with this structure:

```
#research

# Research: <Story title from _story.md>

## Files to Touch

### Likely Modified
- `path/to/file` — reason
- ...

### Likely Created
- `path/to/newfile` — reason
- ...

### Read-Only Reference (patterns to follow)
- `path/to/reference` — what pattern to borrow

## Existing Patterns

<Describe the patterns you found. Be specific — include function/class names, module shapes, and naming conventions. The implementer will copy these.>

## Data Flow

<Trace the relevant path through the stack. Start from the triggering action and go all the way to the data store/outputs, or vice versa.>

## Decisions Made

Document any non-obvious choices you made where multiple reasonable options existed. For each, state the option chosen and why (e.g. "follows existing pattern in X", "simpler given single use case").

1. <decision and rationale>
...

## Open Questions

Only include this section if there are genuine blockers that cannot be resolved from the codebase — for example, a missing external credential, a business rule with no prior precedent anywhere in the code, or a structural ambiguity that would require incompatible implementations depending on the answer. If empty, omit the section entirely.
```

## Step 4 — Present findings

After writing the file, briefly summarize what was found. Do not ask the user to answer questions before planning — the plan agent will proceed autonomously.
