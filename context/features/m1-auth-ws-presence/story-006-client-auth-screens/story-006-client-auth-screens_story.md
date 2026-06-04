---
story: 006
title: "Client: register & login screens"
status: TODO
depends_on: [003, 005]
provides_contract: contracts/client-session.md
---

#story

# Story 006: Client — register & login screens + session persistence

## User Story
As a user, I want first-launch register and returning-user login screens, so that I can authenticate and have my session remembered.

## Acceptance Criteria
- [ ] On launch the app reads the stored session (story 005); if present & still valid (a quick authed call or WS connect) it goes to the app/presence view, else it shows the auth screens.
- [ ] The **register** screen collects server URL, invite token, username, and password → `POST /api/register` (story 003); on success it stores the session via the keychain and proceeds.
- [ ] The **login** screen collects username + password (server URL remembered) → `POST /api/login`; on success it stores the session. Logout clears the keychain and returns to login.
- [ ] The server URL is persisted (replacing the M0 single-screen `DEFAULT_SERVER_URL` flow) so the user does not retype it.
- [ ] Error states are surfaced: invalid/used token, duplicate username, wrong credentials, disabled account, network error.
- [ ] Built with Svelte 5 runes (`$state`, …); the current `App.svelte` ping screen is replaced/extended with a screen/view switch; `npm run typecheck` (svelte-check) passes.
- [ ] `contracts/client-session.md` documents the client auth/session store shape (current user, session token, server URL, `isAuthed`) that story 007 reads to open the WS.

## Context
`SPEC.md §6` flows. Today `App.svelte` is a single ping screen using `DEFAULT_SERVER_URL` (`client/src/lib/config.ts`). This story consumes the `auth-api` contract (003) and the `keychain-commands` contract (005).

## Out of Scope
- The WS connection and presence list (story 007).
- Channel/message UI (M2).
