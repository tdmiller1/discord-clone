---
story: 003
title: "REST API: create channel & message history"
status: TODO
depends_on: [001, 002]
provides_contract: contracts/channels-rest-api.md
---

#story

# Story 003: REST API — create channel & message history

## User Story
As a member, I want to create text channels and fetch a channel's message history over REST, so that the client can add channels and show persisted conversation on (re)load.

## Acceptance Criteria
- [ ] `POST /api/channels` (Bearer auth via M1 `requireAuth`) accepts `{ name, type: "text" }`: it trims and validates `name` (non-empty, ≤ max length) and **rejects `type` ≠ `"text"`** (voice is M4); creates the channel via `createChannel` (story 001) with `created_by` = `request.user.id` and a server-assigned `position`; returns `201` with the `PublicChannel`; and emits `channel.create` to all connected sockets via the story-002 broadcast helper.
- [ ] `GET /api/channels/:id/messages?before=<id>&limit=50` (Bearer auth) returns `PublicMessage[]` using keyset pagination on `id` (`id < before` when `before` is given), newest-first, with `limit` defaulted to 50 and clamped to the configured cap. A nonexistent channel → `404`; a `before` past the oldest row → empty array.
- [ ] Responses are camelCase JSON with epoch-ms timestamps (matching M1's `contracts/auth-api.md` conventions); errors are well-formed: `400` for a malformed body / empty or oversized name / bad `type`, `404 { "error": "channel_not_found" }` for an unknown channel id, `401 { "error": "unauthorized" }` for missing/invalid Bearer.
- [ ] Routes are registered inside `buildApp(config)` (e.g. a `channelRoutes` plugin) and read `fastify.db` — no second db connection, no global singletons.
- [ ] `npm run typecheck` passes; verifiable with `curl`: create a channel (and observe `channel.create` on a connected `wscat`), then send messages over WS and fetch them back via the history endpoint, exercising the `before`/`limit` cursor.
- [ ] `contracts/channels-rest-api.md` documents both endpoints (method, path, auth, request body/query, success + error shapes, pagination semantics) for client stories 004 and 005.

## Context
`SPEC.md §9`: "Any member can create a text channel (`POST /api/channels {name, type:"text"}`) → broadcast `channel.create`"; "History: `GET /api/channels/:id/messages?before=<cursor>&limit=50` (keyset pagination on `id`)." Builds on story 001's accessors, story 002's broadcast helper, and M1's `requireAuth`/`PublicUser` (`contracts/auth-api.md`).

## Out of Scope
- The WS `message.send`/`message.create` path (story 002) — messages are **sent** over WS, only **fetched** over REST.
- Channel rename/delete/reorder endpoints and a `GET /api/channels` list (the channel list is delivered via `ready`, story 002).
- Attachment upload `POST /api/attachments` (M3).
