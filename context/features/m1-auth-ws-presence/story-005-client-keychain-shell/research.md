#research

# Research: Client — Tauri keychain session storage (Rust shell)

## Files to Touch

### Likely Modified
- `client/src-tauri/Cargo.toml` — add the credential-storage crate to `[dependencies]` (alongside the existing `tauri`, `serde`, `serde_json`). See "Decisions Made" for the crate choice.
- `client/src-tauri/src/lib.rs` — currently the bare `tauri::Builder::default().run(...)`. Add `#[tauri::command]` functions for set/get/delete and wire them via `.invoke_handler(tauri::generate_handler![...])`.
- `client/src-tauri/capabilities/default.json` — grant the new commands. With the `keyring` crate approach (custom `#[tauri::command]`s), Tauri v2 auto-generates an ACL permission per command in the app's own `__APP__` namespace; the grant string is the command name (e.g. `"set_session"`), added to the `permissions` array next to `"core:default"`. (If a Tauri *plugin* were used instead, the grant would be `"<plugin>:default"` — but we are not using a plugin; see Decisions.)
- `client/package.json` — no new JS dependency is required; `@tauri-apps/api@^2.2.0` is already present and exports both `invoke` and `isTauri` from `@tauri-apps/api/core`. (Listed here only because the implementer may double-check it; likely no edit.)

### Likely Created
- `client/src/lib/session.ts` — typed webview wrapper. Exports async `getSession()`, `setSession(token)`, `deleteSession()` (or `clearSession()`), invoking the Rust commands and degrading to `null`/no-op when not running under Tauri.
- `client/src-tauri/src/keychain.rs` (optional) — if the implementer prefers to keep the command bodies out of `lib.rs`. Acceptable but not required; `lib.rs` is currently tiny, so inlining the three commands there is also fine and matches the current "everything in lib.rs" shape. (Pick one; do not create an empty stub.)
- `contracts/keychain-commands.md` (i.e. `context/features/m1-auth-ws-presence/story-005-client-keychain-shell/contracts/keychain-commands.md`) — the contract for story 006: command names, arg/return shapes, and the JS wrapper API. This directory does not exist yet and must be created.

### Read-Only Reference (patterns to follow)
- `client/src/App.svelte` — the current (and only) Svelte component; shows the project's TS conventions inside Svelte 5 (`$state`, `async function`, typed `try/catch` with `err instanceof Error`). The new screens (story 006) will consume `session.ts`, not this file, but it establishes the import style (`from "./lib/config"`, no extension) the wrapper should match.
- `client/src/lib/config.ts` — the existing `src/lib/*.ts` module shape: a small, single-purpose TS file with a JSDoc comment and named exports. `session.ts` should mirror this (named exports, no default export).
- `client/src-tauri/src/main.rs` — shows `discord_clone_lib::run()` is the entry; all app wiring lives in `lib.rs`. Do not touch `main.rs`.
- `client/node_modules/@tauri-apps/api/core.d.ts` — confirms `invoke<T>(cmd, args?, options?)` and `isTauri(): boolean` are exported from `@tauri-apps/api/core`. These are the two primitives the wrapper needs.

## Existing Patterns

**Rust shell (current state).** `lib.rs` is a single `pub fn run()` that builds `tauri::Builder::default()` and calls `.run(generate_context!())`. There are no commands and no `.invoke_handler(...)` yet — this story introduces the first one. `main.rs` just calls `discord_clone_lib::run()`; the `[lib]` name in `Cargo.toml` is `discord_clone_lib`. Dependencies today are exactly `tauri = { version = "2" }`, `serde` (with `derive`), `serde_json` — so `serde`'s `derive` is already available for command arg structs if needed (though set/get/delete only need plain `String`/`Option<String>` params, so no custom structs are required).

**Tauri v2 command + capability wiring.** The canonical shape is:
```rust
#[tauri::command]
fn set_session(token: String) -> Result<(), String> { /* keyring set */ }

#[tauri::command]
fn get_session() -> Result<Option<String>, String> { /* keyring get → None if not found */ }

#[tauri::command]
fn delete_session() -> Result<(), String> { /* keyring delete; ok if absent */ }
```
registered via `.invoke_handler(tauri::generate_handler![set_session, get_session, delete_session])` inside `run()`, before `.run(...)`. In Tauri v2, every app-defined command needs an ACL grant or the IPC call is denied at runtime. The grant is added to `capabilities/default.json`'s `permissions` array. The current file is:
```json
{ "identifier": "default", "windows": ["main"], "permissions": ["core:default"] }
```
The three command names get appended to that array. (The exact grant token format — bare command name vs `allow-<command>` — should be confirmed against the generated schema during implementation; Tauri auto-generates per-command permissions for `generate_handler!` commands. The implementer can run `tauri dev` once to regenerate `gen/schemas/*` and read the available identifiers. The `gen/schemas/` files are committed in this repo, so they'll update.)

**Capability arg naming (camelCase ↔ snake_case).** Tauri's IPC auto-converts JS camelCase args to Rust snake_case. The wrapper should pass `{ token }` and the Rust param should be `token: String`. Keep names simple (single word `token`) to avoid casing surprises and document the exact key in the contract.

**Webview module shape.** `src/lib/config.ts` is the template: JSDoc header, named `export const`. `session.ts` follows it but with async functions. The graceful-degradation pattern (criterion 4) uses `isTauri()` from `@tauri-apps/api/core`:
```ts
import { invoke, isTauri } from "@tauri-apps/api/core";
export async function getSession(): Promise<string | null> {
  if (!isTauri()) return null;
  return (await invoke<string | null>("get_session")) ?? null;
}
export async function setSession(token: string): Promise<void> {
  if (!isTauri()) return;            // no-op in browser
  await invoke("set_session", { token });
}
export async function deleteSession(): Promise<void> {
  if (!isTauri()) return;
  await invoke("delete_session");
}
```
`isTauri()` returns false under `cd client && npm run dev` (plain Vite/browser), satisfying the "degrades gracefully / still type-checks and runs" criterion without any try/catch hacks.

**Static gate.** There is no test runner; `npm run typecheck` (root) runs `svelte-check` for the client. The wrapper must be fully typed (no `any`) so `svelte-check` passes. The Rust side is only exercised by `tauri dev`/`tauri build` (the latter runs in CI on ubuntu + windows), so the chosen crate MUST compile on both without extra system packages beyond what CI already installs (see Open Questions / Decisions).

## Data Flow

Set (after a successful login/register in story 006):
1. Webview calls `setSession(token)` in `src/lib/session.ts`.
2. `isTauri()` true → `invoke("set_session", { token })` crosses the IPC boundary.
3. Tauri checks the ACL grant in `capabilities/default.json`; if granted, dispatches to the Rust `set_session` command in `lib.rs`.
4. The command writes the token to the OS keychain (Keychain on macOS, Credential Manager on Windows, Secret Service/libsecret on Linux) under a fixed service + account name (e.g. service `"discord-clone"`, account `"session"`).

Get (on app relaunch, story 006/007 will read this to decide login vs auto-connect):
1. Webview calls `getSession()` → `invoke<string|null>("get_session")`.
2. Rust `get_session` reads the keychain entry; on "no entry found" it returns `Ok(None)` (mapped to JS `null`), on a real error returns `Err(string)` (which `invoke` rejects with — wrapper may let it throw or coalesce; document the chosen behavior in the contract).
3. Webview gets the token string or `null`.

Delete (on logout, or when a stored session is rejected as expired — feature edge case "relaunch with stored-but-expired session → clear the stale token"):
1. `deleteSession()` → `invoke("delete_session")` → Rust removes the keychain entry (treating "not found" as success / idempotent).

Browser-only path (no Rust shell): every wrapper call short-circuits on `isTauri() === false` — `getSession()` → `null`, `setSession`/`deleteSession` → no-op. The webview runs and type-checks; auth simply won't persist, which is acceptable for frontend-only dev.

Security invariant (criterion 3, SPEC §6/§12): only the opaque **session token** is ever passed to `set_session`. The password is never stored in the keychain and must not appear in any wrapper signature. The contract and the Rust command should accept only `token`.

## Decisions Made

1. **Use the `keyring` crate directly via custom `#[tauri::command]`s, not a Tauri plugin.** The story explicitly allows "a keyring plugin or the `keyring` crate." There is no first-party Tauri `keychain`/`keyring` plugin in the official plugins-workspace; community plugins (e.g. `tauri-plugin-keychain`, stronghold) add an extra dependency and an encrypted-vault model (stronghold) that is heavier than "store one opaque string in the OS keychain." Custom commands keep the wiring visible in `lib.rs` + `capabilities/default.json` (exactly the seam the story and CLAUDE.md call out) and match the repo's current "thin Rust shell, everything in lib.rs" shape. Recommended crate: `keyring = "3"`.

2. **Service/account naming: fixed constants, single entry.** Use a constant service name tied to the app (e.g. `"discord-clone"` / the bundle identifier `com.discordclone.app`) and a constant account/user `"session"`. M1 supports a single logged-in session per client install (multi-device is server-side, story 004's edge case), so a single keychain entry suffices. Documented so story 006 doesn't invent its own keys.

3. **Command names: `set_session` / `get_session` / `delete_session`** (snake_case Rust, invoked by the same string from JS). Wrapper exports the more idiomatic-JS `setSession`/`getSession`/`deleteSession`. This keeps the IPC string and Rust fn identical (avoiding `rename` attributes) while giving the webview camelCase ergonomics.

4. **Return shapes: `get` → `Option<String>` (→ `string | null`); `set`/`delete` → `Result<(), String>` (→ `void`/throws on error).** "Entry not found" on get is a normal `None`/`null`, not an error, so relaunch-with-no-session is a clean path. Real backend failures surface as a rejected `invoke` (`Err(String)`). This matches the criterion "returns the stored session string or `null`."

5. **Graceful degradation via `isTauri()` guard, not try/catch.** `@tauri-apps/api/core` exports `isTauri()`; guarding on it is explicit and avoids swallowing real errors. Chosen over wrapping `invoke` in try/catch (which would mask genuine IPC/keychain failures under Tauri).

6. **`session.ts` lives at `client/src/lib/session.ts`** (exact path the story suggests), mirroring `client/src/lib/config.ts`'s module style (named exports, JSDoc). No default export.

7. **Keep command bodies in `lib.rs`** rather than a new `keychain.rs`, given there are only three small commands and the shell is otherwise empty — fewer files, matches current layout. (A `keychain.rs` is acceptable if the implementer prefers; flagged as optional, not required.)

## Open Questions

1. **`keyring` crate's Linux build/runtime requirement in CI.** `npm run tauri build` runs in CI on `ubuntu-latest`, which currently installs only the Tauri GTK/webkit deps + `libssl-dev` (`.github/workflows/ci.yml` lines 50-54). The `keyring` v3 crate's Linux backends need either the Secret Service (`libdbus-1-dev`/`libsecret`, via the default `sync-secret-service`/`async-secret-service` features) or the kernel keyutils backend (`linux-native` feature, links `libkeyutils`). If the default features pull in a system lib not present in the CI image, the cross-platform `tauri build` step will fail to compile/link. The implementer must pick a `keyring` feature set that compiles in CI as-is, and **either** (a) confirm the chosen backend builds with no new apt packages, **or** (b) add the required `apt-get install` line to `.github/workflows/ci.yml` (and the Linux prereqs in `docs/DEVELOPMENT.md`). This is a real structural choice that affects which `Cargo.toml` features and which CI edit are needed; it can't be resolved from the code alone because it depends on the chosen crate/feature combination's link-time deps. (Note: build-time compile vs. runtime keychain availability are separate — CI only needs it to *compile* and *link*; an actual round-trip is verified manually under `tauri dev` per criterion 5, not in CI.)
