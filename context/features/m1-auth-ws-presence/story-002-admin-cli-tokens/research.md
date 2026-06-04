#research

# Research: Admin CLI — mint-token & revoke-user

## Files to Touch

### Likely Modified
- `server/package.json` — add a `"bin"` entry mapping `server` → `dist/cli.js` (so `docker exec <ctr> server mint-token` resolves, per `SPEC.md §6`/`§14`), and add npm scripts (`cli`, plus optional `mint-token` shortcut) for local invocation (`node dist/cli.js …`).
- `package.json` (repo root) — optional convenience script (e.g. `mint-token` delegating to `npm --prefix server`). Mirror the existing `dev:server`/`build:server` delegation pattern. Low priority; the AC only requires *an* npm script, which can live in `server/package.json`.

### Likely Created
- `server/src/cli.ts` — the CLI entry point. New top-level module (sibling of `index.ts`/`app.ts`). Owns argv parsing, the `mint-token` / `revoke-user <username>` / `revoke-token <id>` subcommands, `--help`, opens the DB via `openDatabase(loadConfig())`, writes/queries rows, prints to stdout, sets exit codes. The AC explicitly requires the CLI be its own entry, NOT in `index.ts`.

### Read-Only Reference (patterns to follow)
- `server/src/db.ts` — `openDatabase(config): Db` is the exact factory the CLI must call. It does `mkdirSync` + opens `<dataDir>/app.db` + WAL + `foreign_keys = ON` + `applySchema`. No singleton; the CLI calls it directly against the same `DATA_DIR` file the server uses.
- `server/src/crypto.ts` — reuse `generateToken()` (raw invite token) and `hashToken(raw)` (SHA-256 hex stored in `invite_tokens.token_hash`). Do NOT reimplement hashing. (`hashPassword`/`verifyPassword` are not needed here.)
- `server/src/config.ts` — `loadConfig(): Config` is the only sanctioned way to read env; CLI must use it (gives `config.dataDir`). No scattered `process.env` reads (CLAUDE.md gotcha).
- `server/src/schema.ts` — column shapes for the SQL the CLI writes (`invite_tokens`, `users`, `sessions`). Applied automatically by `openDatabase`, so the CLI never runs DDL itself.
- `server/src/index.ts` — module shape to mirror: thin top-level entry, `loadConfig()` then act. Note the contrast: `index.ts` is listen + signals only; the CLI is the *separate* entry.
- `story-001 contract` (`contracts/data-and-crypto.md`) — authoritative column list + the "Usage notes for 002" block (mint recipe) that this CLI implements verbatim.

## Existing Patterns

- **ESM + `.js` specifiers.** `server` is `"type": "module"`, tsconfig `module/moduleResolution: NodeNext`. Every relative import in `cli.ts` must carry `.js` (e.g. `import { openDatabase } from "./db.js";`, `import { loadConfig } from "./config.js";`, `import { generateToken, hashToken } from "./crypto.js";`). Matches `index.ts`/`app.ts`/`db.ts`.
- **Config-first entry shape** (from `index.ts`): `const config = loadConfig(); …`. The CLI should do `const config = loadConfig(); const db = openDatabase(config);` then dispatch on the subcommand.
- **better-sqlite3 access is synchronous, prepared-statement style.** Schema module uses `db.exec(SQL)`; stories 003/004 (per contract) use `db.prepare(...).get(...)`/`.run(...)`. The CLI should use `db.prepare("INSERT INTO invite_tokens (...) VALUES (?, ?, ?, ?)").run(...)`, `db.prepare("SELECT id, disabled FROM users WHERE username = ?").get(username)`, etc.
- **Timestamps + booleans:** `created_at`/`used_at` = `Date.now()` (epoch ms); `revoked`/`disabled` are `0`/`1` integers. (Contract Tables conventions.)
- **`created_by` on a CLI-minted token is `null`** (contract: "null when minted by admin/CLI with no user") — there is no user context in the CLI.
- **Argv parsing:** Node 24 (`node:util`) exposes `parseArgs` natively (verified `typeof parseArgs === "function"`). No new dependency. A small hand-rolled dispatch (`process.argv.slice(2)`, switch on `argv[0]`) is equally idiomatic and lighter for 2–3 subcommands; either is acceptable. No `commander`/`yargs` in deps and none should be added (keep the "no-fluff" footprint).
- **Logging vs. stdout:** Fastify uses pino logs in the server. The CLI must print the *raw token* and confirmations to plain **stdout** (`console.log`) so `docker exec` capture is clean; errors and the unknown-username path go to **stderr** (`console.error`) with a non-zero `process.exit(1)`.
- **`bin` resolution for the `server` command:** the server `package.json` has no `bin` today; the Dockerfile only `COPY --from=build /app/dist ./dist` and `CMD ["node","dist/index.js"]`. To make `docker exec <ctr> server mint-token` work, add `"bin": { "server": "dist/cli.js" }` to `server/package.json`. Because the package is installed in the image (`npm ci`), npm links `server` into `node_modules/.bin` which is on PATH for `docker exec`. `cli.ts` should start with a `#!/usr/bin/env node` shebang so the linked bin is directly executable. (Acceptable fallback if the implementer prefers not to rely on bin linking: invoke `node dist/cli.js mint-token`; the AC lists both forms.)

## Data Flow

```
docker exec <ctr> server mint-token        (or: node dist/cli.js mint-token)
  → cli.ts main()
  → loadConfig()                            reads DATA_DIR (=/data in the container; ./data in dev)
  → openDatabase(config)                    opens <dataDir>/app.db (SAME file the running server holds open;
                                             WAL mode lets the CLI write while the server reads/writes)
  → dispatch on argv[0]:

  mint-token:
     raw = generateToken()                  crypto.ts
     db.prepare("INSERT INTO invite_tokens (token_hash, created_by, created_at, revoked)
                 VALUES (?, NULL, ?, 0)").run(hashToken(raw), Date.now())
     console.log(raw)                        printed ONCE; only the hash is persisted
     exit 0

  revoke-user <username>:
     row = db.prepare("SELECT id FROM users WHERE username = ?").get(username)
     if !row → console.error("unknown user …"); exit 1
     db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(row.id)
     db.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ?").run(row.id)   // kills all sessions
     console.log(confirmation incl. count of sessions revoked); exit 0

  revoke-token <id> (nice-to-have):
     res = db.prepare("UPDATE invite_tokens SET revoked = 1
                       WHERE id = ? AND used_by IS NULL AND revoked = 0").run(id)
     if res.changes === 0 → error (no such unused token); exit 1
     else confirm; exit 0

  --help / unknown / no command:
     print usage listing the commands; --help exits 0, unknown command exits 1
```

The shared-file guarantee is the crux of AC 4: `openDatabase` targets `<config.dataDir>/app.db`, and the server (`buildApp`) opened the *same path*. WAL journal mode (set by both opens) is what makes a concurrent CLI write safe while the server is running, so a freshly minted token is immediately visible to the server's registration lookup. The CLI should `db.close()` before exiting so WAL is checkpointed cleanly.

## Decisions Made

1. **Single new file `server/src/cli.ts` with subcommand dispatch; no arg-parsing dependency.** Node 24 ships `node:util.parseArgs`, and the command set is tiny — a hand-rolled `switch (argv[0])` (or `parseArgs` for the positionals) keeps the dependency list at zero added packages, consistent with the "no-fluff" ethos and the existing lean `package.json`.
2. **Add `"bin": { "server": "dist/cli.js" }` to `server/package.json` + a `#!/usr/bin/env node` shebang in `cli.ts`.** This is what makes the SPEC-mandated `docker exec <ctr> server mint-token` invocation resolve (npm links the bin onto PATH in the image). The npm script (`"cli": "node dist/cli.js"` or similar) satisfies the AC's "with an npm script" for local/dev use without the build/link step.
3. **`created_by = NULL` for CLI-minted invite tokens.** The contract explicitly allows null ("minted by admin/CLI with no user") and the CLI has no authenticated user. No need to invent an admin user row.
4. **`revoke-user` revokes ALL of the user's sessions in one `UPDATE … WHERE user_id = ?` and sets `disabled = 1`,** matching `SPEC.md §6.5` and the feature's edge-case list ("disables the account and kills all its sessions"). Implemented as two statements; optionally wrapped in `db.transaction(...)` for atomicity (cheap, idiomatic for better-sqlite3) — recommended but not required.
5. **Exit codes + stream discipline:** success → stdout + exit 0; unknown username / unknown or already-used token / unknown subcommand / missing argument → stderr + exit 1. This satisfies "exits non-zero with a clear message" and keeps the raw token the only thing on stdout for `mint-token` (clean `docker exec` capture / piping).
6. **`--help` lists `mint-token`, `revoke-user <username>`, and `revoke-token <id>`.** Required by AC 5. No-args and unrecognized commands print the same usage text (no-args/unknown → exit 1; explicit `--help` → exit 0).
7. **Treat `revoke-token <id>` as in-scope (it is a one-liner once the others exist).** Marked nice-to-have in the AC; implementing it costs almost nothing and rounds out the admin surface. The plan can drop it if scope pressure appears, but the recommendation is to include it.
8. **No DDL in the CLI.** `openDatabase` already calls `applySchema` idempotently, so the CLI inherits a guaranteed-present schema even if it happens to run before the server has ever started.
