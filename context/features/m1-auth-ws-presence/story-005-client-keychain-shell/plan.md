#plan

# Plan: Client — Tauri keychain session storage (Rust shell)

## Summary
Add three Tauri v2 Rust commands (`set_session`/`get_session`/`delete_session`) that read/write a single opaque session token in the OS keychain via the `keyring` crate, grant them in `capabilities/default.json`, wire them through `invoke_handler` in `lib.rs`, and expose a typed `client/src/lib/session.ts` wrapper that degrades to `null`/no-op in the plain-browser (non-Tauri) path. The token only — never the password — is persisted.

## Decisions resolved in this plan (beyond the research's "Decisions Made")
- **Open Question 1 (keyring Linux CI build) → resolved (b): use the Secret Service backend and add `libdbus-1-dev` to CI + dev docs.** The `keyring` v3 default Linux backend (`sync-secret-service`) links against D-Bus (`libdbus-1-dev`) at build time; the current CI image (`ci.yml` lines 50-54) does not install it, so `tauri build` on `ubuntu-latest` would fail to link. The alternative `linux-native` (keyutils) backend does not persist across reboots on most distros — wrong semantics for "stay logged in across relaunches" — so it is rejected. We therefore keep the persistent Secret Service backend and add a single `libdbus-1-dev` apt line to CI and to `docs/DEVELOPMENT.md`'s Linux prereq list. Cargo deps use `default-features = false` + explicit `["apple-native", "windows-native", "sync-secret-service", "crypto-rust"]` to get the persistent OS-keychain backend on every platform while avoiding pulling in an async runtime (tokio) via `async-secret-service`. `crypto-rust` keeps the secret-service encrypted session pure-Rust (no OpenSSL system dep).
- **Research correction: `gen/schemas/` is NOT committed — it is gitignored** (`client/src-tauri/.gitignore` line 3 `/gen/schemas`; root `.gitignore` line 10 `client/src-tauri/gen/`). The research's note that "the gen/schemas files are committed, so they'll update" is wrong. Consequence: the capability grant must use the **bare command name** (`"set_session"`, etc.) in `capabilities/default.json`. For app-defined `generate_handler!` commands, Tauri v2 resolves a bare command-name grant to the auto-generated `allow-<command>` permission in the app's local manifest; this does not depend on any committed schema and works on a clean checkout (CI runs `npm run icons` then `tauri build`, which regenerates `gen/`).
- **Command bodies live in `lib.rs`** (research Decision 7's default) — three small commands, no new `keychain.rs` file.

## Implementation Steps

### Step 1: Add the `keyring` dependency to Cargo.toml
**File(s):** `client/src-tauri/Cargo.toml`
**Action:** modify
**Description:** Add the `keyring` crate to `[dependencies]` so the Rust commands can read/write the OS keychain on macOS (Keychain), Windows (Credential Manager), and Linux (Secret Service). Use explicit, non-default features to pin the persistent OS-keychain backend per platform and avoid an async runtime.
**Diff shape:**
- Add (under `[dependencies]`, after `serde_json = "1"`):
  ```toml
  keyring = { version = "3", default-features = false, features = ["apple-native", "windows-native", "sync-secret-service", "crypto-rust"] }
  ```
- Remove: nothing.
- Change: nothing else (leave `tauri`, `serde`, `serde_json`, `[profile.release]` untouched).

### Step 2: Implement the three keychain commands and register them in lib.rs
**File(s):** `client/src-tauri/src/lib.rs`
**Action:** modify
**Description:** Replace the bare builder with one that defines the three `#[tauri::command]` functions and registers them via `.invoke_handler(tauri::generate_handler![...])`. Use fixed constants for the keychain service (`"discord-clone"`, tied to bundle id `com.discordclone.app`) and account (`"session"`), single-entry per install (research Decision 2). `get` maps "no entry" to `Ok(None)`; `delete` treats "no entry" as success (idempotent); all other backend errors become `Err(String)` so `invoke` rejects (research Decision 4).
**Diff shape:**
- Add (above `run()`):
  ```rust
  use keyring::{Entry, Error as KeyringError};

  const KEYCHAIN_SERVICE: &str = "discord-clone";
  const KEYCHAIN_ACCOUNT: &str = "session";

  fn entry() -> Result<Entry, String> {
      Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
  }

  /// Store the opaque session token in the OS keychain (overwrites any existing).
  #[tauri::command]
  fn set_session(token: String) -> Result<(), String> {
      entry()?.set_password(&token).map_err(|e| e.to_string())
  }

  /// Read the stored session token; `None` when no entry exists.
  #[tauri::command]
  fn get_session() -> Result<Option<String>, String> {
      match entry()?.get_password() {
          Ok(token) => Ok(Some(token)),
          Err(KeyringError::NoEntry) => Ok(None),
          Err(e) => Err(e.to_string()),
      }
  }

  /// Remove the stored session token; succeeds even if absent (idempotent).
  #[tauri::command]
  fn delete_session() -> Result<(), String> {
      match entry()?.delete_credential() {
          Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
          Err(e) => Err(e.to_string()),
      }
  }
  ```
- Change `run()` body to add the handler before `.run(...)`:
  ```rust
  tauri::Builder::default()
      .invoke_handler(tauri::generate_handler![set_session, get_session, delete_session])
      .run(tauri::generate_context!())
      .expect("error while running tauri application");
  ```
- Remove: nothing (`#[cfg_attr(mobile, tauri::mobile_entry_point)]` on `run()` stays).

### Step 3: Grant the three commands in capabilities/default.json
**File(s):** `client/src-tauri/capabilities/default.json`
**Action:** modify
**Description:** Append the three command names to the `permissions` array. Without these grants Tauri v2 denies the IPC call at runtime. Bare command names are the app-local grant form (resolves to the auto-generated `allow-<command>` permission for `generate_handler!` commands).
**Diff shape:**
- Change `"permissions": ["core:default"]` to:
  ```json
  "permissions": ["core:default", "set_session", "get_session", "delete_session"]
  ```
- Add/Remove: nothing else (keep `$schema`, `identifier`, `description`, `windows`).

### Step 4: Create the typed webview wrapper session.ts
**File(s):** `client/src/lib/session.ts`
**Action:** create
**Description:** New `src/lib/*.ts` module mirroring `config.ts` (JSDoc header, named exports, no default export, no `.ts`/`.js` extension on imports). Exports async `getSession`/`setSession`/`deleteSession` that invoke the Rust commands under Tauri and short-circuit via `isTauri()` to `null`/no-op in a plain browser, satisfying graceful degradation (criterion 4) and keeping `svelte-check` green with no `any`.
**Diff shape:**
- Add file content:
  ```ts
  /**
   * Session-token persistence backed by the OS keychain via the Tauri Rust shell.
   * Stores the opaque session token only — never the password (SPEC.md §6/§12).
   * In the plain-browser dev path (no Tauri), every call short-circuits:
   * getSession() -> null, setSession/deleteSession -> no-op.
   */
  import { invoke, isTauri } from "@tauri-apps/api/core";

  /** Read the stored session token, or null if none / not running under Tauri. */
  export async function getSession(): Promise<string | null> {
    if (!isTauri()) return null;
    return (await invoke<string | null>("get_session")) ?? null;
  }

  /** Persist the session token in the OS keychain (no-op outside Tauri). */
  export async function setSession(token: string): Promise<void> {
    if (!isTauri()) return;
    await invoke("set_session", { token });
  }

  /** Remove the stored session token; idempotent (no-op outside Tauri). */
  export async function deleteSession(): Promise<void> {
    if (!isTauri()) return;
    await invoke("delete_session");
  }
  ```
- Remove/Change: nothing (new file).

### Step 5: Add libdbus-1-dev to CI Linux build deps
**File(s):** `.github/workflows/ci.yml`
**Action:** modify
**Description:** The `keyring` Secret Service backend links D-Bus at build time; add `libdbus-1-dev` to the existing `apt-get install` in the client job's "Install Linux build dependencies" step so `tauri build` links on `ubuntu-latest`. (CI only needs it to compile/link; the actual keychain round-trip is verified manually under `tauri dev`, criterion 5.)
**Diff shape:**
- Change the apt install list (lines ~51-54) to append `libdbus-1-dev`, e.g. add it to the final line:
  ```yaml
  file libssl-dev libxdo-dev libdbus-1-dev
  ```
- Add/Remove: nothing else; do not touch the server job.

### Step 6: Document the new Linux prerequisite in DEVELOPMENT.md
**File(s):** `docs/DEVELOPMENT.md`
**Action:** modify
**Description:** Keep the docs in sync with CI: add `libdbus-1-dev` to the Linux Tauri-deps list under Prerequisites so a local Linux dev can build the client with keychain support.
**Diff shape:**
- Change the Linux deps line to append `libdbus-1-dev`:
  ```
  Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev patchelf build-essential file libssl-dev libxdo-dev libdbus-1-dev`
  ```
- Add/Remove: nothing else.

### Step 7: Write the contract for story 006
**File(s):** `context/features/m1-auth-ws-presence/story-005-client-keychain-shell/contracts/keychain-commands.md`
**Action:** create
**Description:** The `contracts/` directory does not exist yet (`provides_contract: contracts/keychain-commands.md`); create it and the file. Document the Rust command names, their arg/return shapes (including snake_case Rust ↔ camelCase JS IPC and the `{ token }` arg key), the keychain service/account constants, the JS wrapper API and its types, and the browser-degradation behavior — so story 006 (auth screens) consumes a stable surface.
**Diff shape:**
- Add file documenting: command table (`set_session(token: String) -> Result<(), String>`, `get_session() -> Result<Option<String>, String>`, `delete_session() -> Result<(), String>`); IPC arg key `{ token }`; service `"discord-clone"` / account `"session"`; wrapper signatures `getSession(): Promise<string | null>`, `setSession(token: string): Promise<void>`, `deleteSession(): Promise<void>`; error model (get-not-found → null; backend error → rejected promise; set/delete reject on backend error, delete is idempotent); non-Tauri degradation (getSession → null, set/delete → no-op).
- Remove/Change: nothing (new file + new dir).

## New Types / Schemas / Contracts

```rust
// client/src-tauri/src/lib.rs — Tauri IPC commands (snake_case = the invoke() string)
set_session(token: String) -> Result<(), String>          // JS arg: { token }
get_session()             -> Result<Option<String>, String>
delete_session()          -> Result<(), String>

// keychain coordinates (constants)
service = "discord-clone"   // tied to bundle id com.discordclone.app
account = "session"          // single entry per install
```

```ts
// client/src/lib/session.ts — webview wrapper (the surface story 006 imports)
getSession():    Promise<string | null>   // null = no stored token OR not under Tauri
setSession(token: string): Promise<void>   // no-op outside Tauri
deleteSession(): Promise<void>             // idempotent; no-op outside Tauri
```

## Configuration / Environment Changes

- **Cargo dependency** `keyring = { version = "3", default-features = false, features = ["apple-native", "windows-native", "sync-secret-service", "crypto-rust"] }` — registered in `client/src-tauri/Cargo.toml` `[dependencies]` (Step 1).
- **Capability grants** `"set_session"`, `"get_session"`, `"delete_session"` — registered in `client/src-tauri/capabilities/default.json` `permissions` (Step 3).
- **CI system package** `libdbus-1-dev` — registered in `.github/workflows/ci.yml` client-job apt install (Step 5) and `docs/DEVELOPMENT.md` Linux prereqs (Step 6).
- **Keychain entry** (runtime, persisted in OS keychain, not a repo file): service `"discord-clone"`, account `"session"`, value = opaque session token (Step 2). No new env vars; no server-side or SQLite changes.

## API / Interface Changes

| Surface | Identifier | Request / Input | Response / Output | Notes |
| ------- | ---------- | --------------- | ----------------- | ----- |
| Tauri IPC command | `set_session` | `{ token: string }` | `void` (rejects with string on backend error) | App-local; granted in `capabilities/default.json`. Overwrites existing entry. |
| Tauri IPC command | `get_session` | none | `string \| null` (rejects on real backend error) | "No entry" → `null`, not an error. |
| Tauri IPC command | `delete_session` | none | `void` (rejects on backend error) | Idempotent: "no entry" → success. |
| Public TS fn | `getSession` (`client/src/lib/session.ts`) | none | `Promise<string \| null>` | `null` if not under Tauri or no token. |
| Public TS fn | `setSession` | `token: string` | `Promise<void>` | No-op outside Tauri. Token only — never password. |
| Public TS fn | `deleteSession` | none | `Promise<void>` | No-op outside Tauri; idempotent. |

## Edge Cases & Gotchas

- **No stored session on first launch / after logout** — `get_session` returns `Ok(None)` → wrapper returns `null` (clean login-screen path). Handled in Step 2 (`KeyringError::NoEntry` → `Ok(None)`) and Step 4.
- **Delete when nothing is stored (double logout / clearing stale token)** — `delete_session` treats `NoEntry` as success; idempotent. Handled in Step 2.
- **Browser-only dev (`cd client && npm run dev`, no Rust shell)** — `isTauri()` is false; `getSession` → `null`, `set`/`delete` → no-op; webview still type-checks and runs (criterion 4). Handled in Step 4.
- **Missing ACL grant → runtime IPC denial** — without Step 3 the `invoke` calls are denied even though the commands compile. Handled in Step 3.
- **Linux CI link failure** — `keyring` Secret Service backend needs `libdbus-1-dev` at build/link time, absent from the current CI image; would break `tauri build` on ubuntu. Handled in Step 5 (and Step 6 for local dev).
- **`gen/schemas/` is gitignored, not committed** — the grant must be a bare command name (app-local form) that works on a clean checkout where `gen/` is regenerated by `tauri build`; do not rely on any locally-present generated identifier. Handled in Step 3 (decision documented in Summary).
- **camelCase ↔ snake_case IPC** — JS must pass `{ token }` (single word, no casing ambiguity) to the `token: String` Rust param. Documented in the contract (Step 7) and used in Step 4.
- **Security invariant: token only, never password** — no wrapper or command accepts a password; only `token` crosses the boundary (criterion 3, SPEC §6/§12). Enforced by the signatures in Steps 2, 4 and asserted in the contract (Step 7).
- **Real keychain backend error (e.g. locked keyring, no Secret Service running)** — surfaces as `Err(String)` → rejected `invoke`; the wrapper does not swallow it (no try/catch), so story 006 can decide UX. Handled in Steps 2 and 4.

## Acceptance Criteria Checklist

- [ ] The Tauri shell exposes set/get/delete commands registered in `lib.rs` and granted in `capabilities/default.json` → Step 1, Step 2, Step 3
- [ ] A small typed webview wrapper (`client/src/lib/session.ts`) invokes them and returns the stored session string or `null` → Step 4
- [ ] The stored value is the session token only — never the password (SPEC §6/§12) → Step 2, Step 4, Step 7 (signatures accept only `token`)
- [ ] Browser-only path degrades gracefully (wrapper returns `null`/no-ops; webview type-checks and runs without Tauri) → Step 4
- [ ] Cargo deps added; `npm run typecheck` (svelte-check) passes; under `tauri dev` a set → get → delete round-trip works → Step 1 (dep), Step 4 (typed wrapper for svelte-check), Steps 2+3 (round-trip), Step 5+6 (build deps so `tauri dev`/`build` link)
- [ ] `contracts/keychain-commands.md` documents command names, arg/return shapes, and the JS wrapper API for story 006 → Step 7
