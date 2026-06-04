#plan

# Plan: Admin CLI — mint-token & revoke-user

## Summary
Add a standalone ESM CLI entry (`server/src/cli.ts`, compiled to `dist/cli.js`) with `mint-token`, `revoke-user <username>`, `revoke-token <id>`, and `--help` subcommands that open the **same** `<DATA_DIR>/app.db` via `openDatabase(loadConfig())` and reuse the story-001 `crypto` helpers. Wire it up through a `"bin"` entry plus an npm `cli` script so the admin can run it via `docker exec <ctr> server mint-token` (or `node dist/cli.js …`) to onboard/offboard the ~10 users out-of-band.

## Implementation Steps

### Step 1: Create the CLI entry point
**File(s):** `server/src/cli.ts`
**Action:** create
**Description:** New top-level module (sibling of `index.ts`/`app.ts`) that owns argv parsing, subcommand dispatch, DB access, stdout/stderr output, and exit codes. It must NOT live in `index.ts` (AC 5 / CLAUDE.md: `index.ts` is listen + signals only). Structure:
- First line is the shebang `#!/usr/bin/env node` so the linked bin (`server`) is directly executable on PATH inside the container.
- ESM `.js`-suffixed imports: `import { loadConfig } from "./config.js";`, `import { openDatabase, type Db } from "./db.js";`, `import { generateToken, hashToken } from "./crypto.js";`.
- A `USAGE` string listing the three commands (see "API / Interface Changes").
- A synchronous `main()` that: reads `const argv = process.argv.slice(2);`, takes `const command = argv[0]`, and dispatches with a `switch`. All subcommand bodies are synchronous (better-sqlite3 is sync; no Argon2 needed here, so `main` does not need to be async).
- Opens the DB **once** lazily — only for commands that need it (i.e. not for `--help`/no-args/unknown) so `--help` works even before `DATA_DIR` exists. Pattern: `const config = loadConfig(); const db = openDatabase(config);` inside each DB-using branch (or open once after the help/unknown branches return). Always `db.close()` before returning from a DB-using branch so WAL is checkpointed cleanly.
- Process-level error discipline: wrap the dispatch so any thrown error → `console.error(message)` + `process.exitCode = 1`. Success paths fall through to a clean exit (exit code defaults to 0).

**Diff shape:**
- Add: `server/src/cli.ts` with shebang, imports, `USAGE` constant, helper(s) for each subcommand, and `main()` invoked at module top level (`main();`).
- Remove: nothing.
- Change: nothing.

### Step 2: Implement `mint-token`
**File(s):** `server/src/cli.ts`
**Action:** create (sub-section of Step 1)
**Description:** Generate a raw invite token, persist only its hash, print the raw token once. Per the story-001 contract "Invite mint (002)" recipe:
```ts
const raw = generateToken();
db.prepare(
  "INSERT INTO invite_tokens (token_hash, created_by, created_at, revoked) VALUES (?, NULL, ?, 0)"
).run(hashToken(raw), Date.now());
console.log(raw); // raw token is the ONLY thing on stdout — clean for docker exec capture / piping
```
`created_by` is `NULL` (CLI has no authenticated user; contract permits null). `used_by`/`used_at` are left NULL (column defaults / omitted). Nothing else is written to stdout for this command.
**Diff shape:**
- Add: `case "mint-token":` branch performing the insert + single `console.log(raw)`.
- Remove: nothing.
- Change: nothing.

### Step 3: Implement `revoke-user <username>`
**File(s):** `server/src/cli.ts`
**Action:** create (sub-section of Step 1)
**Description:** Disable the account and revoke all its sessions. Read the username positional (`argv[1]`); if missing → `console.error("usage: server revoke-user <username>")` + exit 1. Look up the user; if absent → `console.error(\`unknown user: ${username}\`)` + exit 1 (AC 2). On hit, perform two updates atomically and report the session count:
```ts
const row = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as { id: number } | undefined;
if (!row) { console.error(`unknown user: ${username}`); process.exitCode = 1; return; }
const revokeAll = db.transaction((userId: number) => {
  db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(userId);
  const res = db.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0").run(userId);
  return res.changes;
});
const sessionsRevoked = revokeAll(row.id);
console.log(`revoked user "${username}" (disabled account, ${sessionsRevoked} session(s) revoked)`);
```
Cast `.get(...)` results to a typed shape (better-sqlite3 returns `unknown`); use a local `interface`/inline type — strict mode requires it. Wrap the two writes in `db.transaction(...)` for atomicity (idiomatic for better-sqlite3, cheap). Filtering `AND revoked = 0` makes the reported count reflect sessions actually changed.
**Diff shape:**
- Add: `case "revoke-user":` branch with arg validation, lookup, transactional update, confirmation log.
- Remove: nothing.
- Change: nothing.

### Step 4: Implement `revoke-token <id>` (nice-to-have, in scope)
**File(s):** `server/src/cli.ts`
**Action:** create (sub-section of Step 1)
**Description:** Revoke an unused, not-already-revoked invite token by id. Read `argv[1]`; validate it parses to a positive integer (`Number.isInteger`) else error + exit 1. Then:
```ts
const res = db.prepare(
  "UPDATE invite_tokens SET revoked = 1 WHERE id = ? AND used_by IS NULL AND revoked = 0"
).run(id);
if (res.changes === 0) { console.error(`no unused invite token with id ${id}`); process.exitCode = 1; return; }
console.log(`revoked invite token ${id}`);
```
The `used_by IS NULL AND revoked = 0` guard means already-used or already-revoked tokens report the same clear failure (exit 1).
**Diff shape:**
- Add: `case "revoke-token":` branch with int parse/validation, guarded update, confirmation.
- Remove: nothing.
- Change: nothing.

### Step 5: Implement `--help` / no-args / unknown command
**File(s):** `server/src/cli.ts`
**Action:** create (sub-section of Step 1)
**Description:** A `USAGE` string lists all three commands (AC 5). Behavior:
- `--help` (or `-h`) → `console.log(USAGE)`, exit 0.
- No command (`argv.length === 0`) → `console.error(USAGE)`, exit 1.
- Unrecognized command → `console.error(\`unknown command: ${command}\n\n${USAGE}\`)`, exit 1.
These branches return before opening the DB.
**Diff shape:**
- Add: `case "--help": case "-h":` (exit 0) plus the `default:` / no-args handling (exit 1).
- Remove: nothing.
- Change: nothing.

### Step 6: Register the CLI bin + npm scripts
**File(s):** `server/package.json`
**Action:** modify
**Description:** Add a `"bin"` mapping so `server mint-token` resolves, and npm script(s) for local/dev invocation. The compiled output is `dist/cli.js` (tsconfig `outDir: "dist"`, `rootDir: "src"`).
```jsonc
"bin": { "server": "dist/cli.js" },
"scripts": {
  // ...existing dev/build/start/typecheck...
  "cli": "node dist/cli.js"
}
```
The `cli` script satisfies AC 1's "with an npm script" for local use (`npm run cli mint-token`). The `bin` entry is what npm links onto PATH so `docker exec <ctr> server mint-token` works (see Edge Cases for the linking caveat).
**Diff shape:**
- Add: top-level `"bin": { "server": "dist/cli.js" }` and a `"cli": "node dist/cli.js"` script.
- Remove: nothing.
- Change: nothing.

### Step 7 (optional convenience): Root-level npm script
**File(s):** `package.json` (repo root)
**Action:** modify
**Description:** Mirror the existing `dev:server`/`build:server` delegation with an optional `mint-token` (or `cli:server`) script delegating into `server/`. Low priority — AC 1 is already satisfied by the `server/package.json` `cli` script. Include only if a one-shot root command is desired:
```jsonc
"cli:server": "npm --prefix server run cli --"
```
**Diff shape:**
- Add: one delegating script under root `scripts`.
- Remove: nothing.
- Change: nothing.

## New Types / Schemas / Contracts

No new persisted schema (story-001's `invite_tokens`/`users`/`sessions` are reused as-is; `openDatabase` applies the DDL idempotently). No exported public API — `cli.ts` is an executable entry, not an importable module. Internal row shapes used for `better-sqlite3` `.get()` casts (strict mode):

```ts
// local to cli.ts
type UserRow = { id: number };
// (revoke-token uses RunResult.changes; no row type needed)
```

This story `provides_contract:` is empty — nothing downstream consumes the CLI as an interface.

## Configuration / Environment Changes

- **`server/package.json` `bin`:** add `"bin": { "server": "dist/cli.js" }`. Registers the `server` executable; npm links it (where applicable) so `docker exec … server mint-token` resolves.
- **`server/package.json` script:** add `"cli": "node dist/cli.js"`. For local/dev invocation after `npm run build` (`npm run cli mint-token`).
- **(optional) root `package.json` script:** `"cli:server": "npm --prefix server run cli --"`.
- **No new env vars.** The CLI reads only `DATA_DIR` (and the rest of `Config`) through the existing `loadConfig()`; `.env.example` / `SPEC.md §12` need no additions.

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| CLI command | `mint-token` | none | stdout: raw invite token (single line); exit 0 | Persists only `hashToken(raw)`; `created_by=NULL`, `revoked=0` |
| CLI command | `revoke-user <username>` | positional `<username>` | stdout: `revoked user "<u>" (disabled account, N session(s) revoked)`; exit 0. Unknown user / missing arg → stderr + exit 1 | Sets `users.disabled=1` and `sessions.revoked=1` for all the user's sessions, in one transaction |
| CLI command | `revoke-token <id>` | positional `<id>` (positive int) | stdout: `revoked invite token <id>`; exit 0. No unused token / bad id → stderr + exit 1 | Guard `used_by IS NULL AND revoked = 0` |
| CLI command | `--help` / `-h` | none | stdout: usage listing all 3 commands; exit 0 | No-args & unknown command print usage to stderr, exit 1 |
| npm script | `npm run cli -- <cmd>` (in `server/`) | passthrough argv | delegates to `node dist/cli.js <cmd>` | Dev/local convenience |
| executable | `server <cmd>` (via `bin`) | passthrough argv | runs `dist/cli.js` | Primary `docker exec` form per SPEC §6 |

## Edge Cases & Gotchas

- **`bin` linking caveat (the real correctness risk).** A package's own `bin` is linked into `node_modules/.bin` only when the package is installed *as a dependency*; for a top-level project that just runs `npm ci` on its own `package.json`, npm does **not** auto-link the project's own `bin` onto PATH. So `docker exec <ctr> server mint-token` may not resolve from the current Dockerfile as-is. Mitigations, in order of preference: (a) rely on the documented fallback `docker exec <ctr> node dist/cli.js mint-token` — the AC explicitly lists both forms and this always works; (b) if the bare `server` form is wanted, a follow-up can add `RUN npm link` (or a `ln -s` into a PATH dir) in the runtime stage — out of scope here, note it for the implementer. The `bin` entry is still added (harmless, documents intent, enables `npm link`). — handled in Step 6 + note here.
- **`--help` must work without a DB / DATA_DIR.** Open the DB lazily inside DB-using branches only, so `--help`/no-args/unknown never touch `openDatabase`. — handled in Step 1 & 5.
- **Concurrent access with the running server.** Both opens set `journal_mode = WAL` (in `openDatabase`), so a CLI write is safe while the server holds the file open, and a minted token is immediately visible to the server's registration lookup (AC 4). Call `db.close()` before exiting DB-using branches for a clean WAL checkpoint. — handled in Step 1.
- **stdout vs stderr discipline.** `mint-token` prints ONLY the raw token to stdout (clean capture/piping); all confirmations go to stdout, all errors/usage-on-failure to stderr with `process.exitCode = 1`. No pino/Fastify logger in the CLI. — handled in Steps 2–5.
- **Missing positional arg** (`revoke-user`/`revoke-token` with no operand) → clear stderr usage message + exit 1, not a crash. — handled in Steps 3–4.
- **`revoke-token` id parsing** — reject non-integer/non-positive ids before the query. — handled in Step 4.
- **better-sqlite3 returns `unknown` from `.get()`** — strict mode requires a cast to a typed row shape. — handled in Step 3 / Types.
- **No DDL in the CLI** — `openDatabase` already runs `applySchema` idempotently, so the CLI works even if it runs before the server's first start. — handled by reusing `openDatabase` (Step 1).
- **`process.exit()` vs `process.exitCode`** — prefer setting `process.exitCode` and returning (lets `db.close()`/WAL flush complete) over an abrupt `process.exit(1)` mid-write.

## Acceptance Criteria Checklist

- [ ] CLI entry generates a random invite token, stores only its hash (`hashToken`) in `invite_tokens` (unused, not revoked), prints raw token once to stdout; invocable as `server mint-token` / `node dist/cli.js mint-token` with an npm script → Steps 1, 2, 6
- [ ] `server revoke-user <username>` sets `users.disabled=1`, revokes all the user's sessions, prints confirmation; unknown username exits non-zero with a clear message → Step 3
- [ ] (Nice-to-have) `server revoke-token <id>` revokes an unused invite token → Step 4
- [ ] Commands reuse `db` + crypto helpers from story 001 (no duplicated hashing) and run against the same `DATA_DIR`/SQLite file the server uses → Steps 1–4 (uses `openDatabase`/`loadConfig`/`generateToken`/`hashToken`; WAL guarantee)
- [ ] CLI lives in its own entry (`server/src/cli.ts`), not `index.ts`; `--help` lists the commands → Steps 1, 5
- [ ] `npm run typecheck` passes; mint→register→login round-trips once story 003 lands → typed row casts (Step 3), correct ESM `.js` imports (Step 1), schema-compatible inserts (Step 2)
