# Contract: Keychain session storage (story 005 → story 006)

The Tauri Rust shell persists the **opaque session token only** (never the password,
SPEC.md §6/§12) in the OS keychain (macOS Keychain, Windows Credential Manager, Linux
Secret Service). Story 006 (auth screens) consumes the JS wrapper below — it should not
call `invoke` directly.

## Keychain coordinates (fixed constants)

A single entry per client install:

- **service** = `"discord-clone"` (tied to bundle id `com.discordclone.app`)
- **account** = `"session"`

## Tauri IPC commands (`client/src-tauri/src/lib.rs`)

Registered in `invoke_handler(generate_handler![...])` and granted in
`client/src-tauri/capabilities/default.json` (`"set_session"`, `"get_session"`,
`"delete_session"` in the `permissions` array). The Rust function name **is** the
`invoke()` command string (snake_case).

| Command | JS args | Rust signature | Resolves with | Rejects with |
| ------- | ------- | -------------- | ------------- | ------------ |
| `set_session` | `{ token }` (string) | `set_session(token: String) -> Result<(), String>` | `void` | `string` on backend error. Overwrites any existing entry. |
| `get_session` | none | `get_session() -> Result<Option<String>, String>` | `string \| null` | `string` on real backend error. "No entry" → `null` (not an error). |
| `delete_session` | none | `delete_session() -> Result<(), String>` | `void` | `string` on backend error. Idempotent: "no entry" → success. |

**IPC arg key:** the JS arg object key is exactly `token` (single word — no camelCase ↔
snake_case ambiguity). Tauri maps `{ token }` → the Rust `token: String` param.

**Error model:** "entry not found" on `get_session` is a normal `Ok(None)` → `null`, so a
fresh launch with no stored session is a clean path. Genuine backend failures (locked
keyring, no Secret Service running, etc.) surface as `Err(String)` → a **rejected**
`invoke` promise; the wrapper does not swallow them.

## JS wrapper API (`client/src/lib/session.ts`)

Import these (named exports, no default export):

```ts
import { getSession, setSession, deleteSession } from "./lib/session";

// Read the stored token. null = no token OR not running under Tauri.
getSession(): Promise<string | null>

// Persist the token (the opaque session token only — never a password). No-op outside Tauri.
setSession(token: string): Promise<void>

// Remove the stored token. Idempotent. No-op outside Tauri.
deleteSession(): Promise<void>
```

## Non-Tauri (plain-browser) degradation

When running `cd client && npm run dev` (Vite in a browser, no Rust shell),
`isTauri()` is `false` and every call short-circuits:

- `getSession()` → resolves `null`
- `setSession(token)` → no-op (resolves `void`)
- `deleteSession()` → no-op (resolves `void`)

The webview still type-checks and runs; auth simply does not persist in that path.
