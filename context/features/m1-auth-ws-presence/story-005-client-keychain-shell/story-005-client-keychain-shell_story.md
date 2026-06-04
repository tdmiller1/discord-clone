---
story: 005
title: "Client: Tauri keychain session storage"
status: TODO
depends_on: []
provides_contract: contracts/keychain-commands.md
---

#story

# Story 005: Client — Tauri keychain session storage (Rust shell)

## User Story
As a user, I want my session token kept in the OS keychain, so that I stay logged in across relaunches without my password ever being stored.

## Acceptance Criteria
- [ ] The Tauri shell exposes commands to **set / get / delete** the session token in the OS keychain (e.g. via a keyring plugin or the `keyring` crate), registered in `src-tauri/src/lib.rs` and **granted** in `src-tauri/capabilities/default.json`.
- [ ] A small typed webview wrapper (e.g. `client/src/lib/session.ts`) invokes those commands and returns the stored session string or `null`.
- [ ] The stored value is the **session token only** — never the password (`SPEC.md §6`/`§12`).
- [ ] The browser-only path (`cd client && npm run dev`, no Rust shell) **degrades gracefully** (wrapper returns `null` / no-ops) so the webview still type-checks and runs without Tauri.
- [ ] Cargo deps added; `npm run typecheck` (svelte-check) passes; under `npm run dev:client` (`tauri dev`) a set → get → delete round-trip works.
- [ ] `contracts/keychain-commands.md` documents the command names, argument/return shapes, and the JS wrapper API for story 006.

## Context
`SPEC.md §3`/`§6`: the session token lives in the OS keychain via the Rust shell. Per CLAUDE.md, new commands must be granted in `capabilities/default.json`, and `lib.rs` is currently the bare `tauri::Builder::default().run(...)`. This is the "Rust shell owns credential storage" seam, independent of the server.

## Out of Scope
- The auth UI / screens (story 006).
- Anything server-side.
