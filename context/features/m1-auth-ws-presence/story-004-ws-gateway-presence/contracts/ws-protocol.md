#contract

# Contract: WebSocket gateway & presence protocol (story 004)

Authoritative interface for the M1 realtime gateway (SPEC.md §7). Story 007 (client)
consumes exactly what is documented here. Builds on story 003's session validator
(`authenticateSession`, see `contracts/auth-api.md`) — the WS gateway reuses it and
does not reimplement session lookup.

Voice ops (`voice.*`, SPEC.md §11) are M4 and out of scope. `message.*`/`channel.*`
are M2. The gateway defines **exactly one** client→server op in M1: `identify`.

## Endpoint

```
ws://<host>:8080/ws        (default port; matches HTTP_PORT)
```

A standard WebSocket upgrade. There is **no** `Authorization` header on the
handshake (browsers/webviews cannot set one on a `WebSocket`), and the raw session
token is **not** put in the URL query (to keep it out of access/proxy logs).
Authentication happens on the first frame (see Handshake). The connection is
unauthenticated until then.

## Envelope

Every frame in both directions is JSON of the shape:

```jsonc
{ "op": "<string>", "d": <payload> }
```

Frames that are not valid JSON, not an object, or lack a string `op` are **ignored**
(never crash the connection). Unknown ops are ignored safely.

## Handshake (`identify`)

Immediately after the socket opens, the client MUST send, as its **first frame**:

```jsonc
{ "op": "identify", "d": { "token": "<raw-session-token>" } }
```

- `token` is the **raw** opaque session token returned by `POST /api/login`,
  `/api/register`, or `/api/refresh` (the same value used as the REST Bearer
  credential — see `contracts/auth-api.md`). It is `hashToken`-ed and looked up
  server-side via `authenticateSession`; never sent in plaintext to the DB.
- **Auth deadline: 10 seconds.** If a valid `identify` does not arrive within 10 s
  of connecting, the server closes the socket with code `4001` (see Close codes).
- On a valid token: the server sends exactly one `ready` frame (see below) and the
  connection is now authenticated. Before that point, any op other than `identify`
  is ignored (the deadline still applies). A second `identify` after auth is
  ignored.
- On an invalid/expired/revoked token, a disabled user, or a non-string/missing
  `token`: the server closes with `4001` and **never** sends `ready`.

## Close codes

| Code   | Meaning      | When                                                                                              |
| ------ | ------------ | ------------------------------------------------------------------------------------------------- |
| `4001` | unauthorized | Missing/invalid/expired/revoked session, disabled user, missing `identify` before the deadline, or mid-session revocation detected by the heartbeat reaper. Single opaque code — no distinguishing detail (mirrors the REST uniform 401). |
| `1009` | too large    | An inbound frame exceeded the max frame size.                                                      |

**Client guidance (story 007):** treat a `4001` close as "session is no longer
valid" → clear the stored session and return to the login screen. It is the single
signal for every auth failure, including a session revoked while connected.

## `ready` (server→client)

Sent exactly once, only after a successful `identify`:

```jsonc
{
  "op": "ready",
  "d": {
    "user": {                       // PublicUser — the authenticated user
      "id": 1,
      "username": "alice",
      "displayName": null,
      "createdAt": 1780610454376
    },
    "channels": [],                 // always empty in M1 (channels arrive in M2)
    "members": [                    // every non-disabled user + live presence
      {
        "id": 1,
        "username": "alice",
        "displayName": null,
        "createdAt": 1780610454376,
        "status": "online",         // "online" | "offline"
        "voiceChannelId": null      // always null in M1 (voice arrives in M4)
      }
      // ...one entry per non-disabled user
    ]
  }
}
```

- `members` lists **all non-disabled users** (`WHERE disabled = 0`), not only the
  online ones. Each is a `PublicUser` plus `status` (`"online"` iff that user has
  at least one live socket at the moment `ready` is built) and `voiceChannelId`
  (always `null` in M1).
- The connecting user appears in their own `members` list as `"online"` (the socket
  is registered before `ready` is built).
- Disabled users are omitted entirely.

A `Member` is, in TypeScript (`server/src/types.ts`):

```ts
interface Member extends PublicUser {
  status: "online" | "offline";
  voiceChannelId: number | null; // null in M1
}
```

## `presence.update` (server→client)

Broadcast when a user's online state flips:

```jsonc
{
  "op": "presence.update",
  "d": {
    "userId": 1,
    "status": "online",   // "online" | "offline"
    "voiceChannelId": null // always null in M1
  }
}
```

- `status: "online"` is broadcast when a user's **first** socket authenticates
  (the transition from 0 → 1 live sockets). It is sent to all *other* connected
  clients; the joining client learns its own online state from its `ready.members`.
- `status: "offline"` is broadcast when a user's **last** socket closes (the
  transition from 1 → 0 live sockets), to all connected clients.
- A user with multiple concurrent sockets (e.g. two devices) emits `online` only on
  the first and `offline` only on the last — no per-socket churn in between.

Clients should apply these to the `members` map received in `ready` (update the
matching `userId`'s `status`).

## Heartbeat

- The server pings every connected socket on a **30-second** interval and expects a
  pong (the `ws`/WebSocket layer answers pongs automatically; no client app code is
  required).
- If a socket misses a full interval (no pong), the server terminates it; the
  resulting close flips that user's presence to `offline` if it was their last
  socket. This is what prevents presence from getting stuck `online` after an abrupt
  disconnect (network drop / app kill).
- The same 30-second tick re-validates each authenticated socket's session. A
  session revoked out-of-band (e.g. admin `server revoke-user`, which only mutates
  SQLite in a separate process) is detected here and the affected sockets are closed
  with `4001` within one interval (≤30 s), flipping presence to `offline`.
- A revoked/expired/disabled session can **never** establish a *new* connection —
  that is enforced synchronously at `identify` (close `4001`, no `ready`).

## Frame limits

- **Max inbound frame size: 65536 bytes (64 KiB).** Enforced by the `ws`
  `maxPayload` option plus a defensive length guard. Oversize frames close the
  socket with `1009`.

## Out of scope (do not send)

- `voice.join` / `voice.leave` / `voice.signal` / `voice.state` — M4 (SPEC.md §11).
- `message.send` / `message.create` / `channel.create` — M2.
- Any client→server op other than `identify` in M1; the server ignores them.
