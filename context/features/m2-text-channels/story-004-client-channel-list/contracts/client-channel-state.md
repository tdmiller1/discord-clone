#contract

# Contract: Client channel state — list & active selection (story 004)

Authoritative client-side interface for the M2 channel list and active-channel
selection. Story 005 (message pane / composer / history) consumes this to know
**which** channel to fetch and render. All modules are the Tauri + Svelte 5 client:
runes (`$state`/`$derived`/`$effect`), bundler imports (**no `.js` suffix**).

## Channel shape

`PublicChannel` (`client/src/lib/types.ts`) — the client mirror of the
story-003 server shape (camelCase, epoch-ms `createdAt`):

```ts
export interface PublicChannel {
  id: number;
  name: string;
  type: "text" | "voice";
  position: number;
  createdBy: number | null;
  createdAt: number;
}
```

## The channel list lives on the gateway

`gateway` (`client/src/lib/gateway.svelte.ts`) owns the reactive list — it is fed
by WS frames (`ready.channels`, `channel.create`):

```ts
import { gateway } from "./gateway.svelte";

gateway.channels; // PublicChannel[] — getter
```

Semantics:

- **Text only.** `type === "voice"` channels are filtered out (voice is M4).
- **Sorted** by `position` then `id` (tiebreak), matching server ordering.
- **Seeded** from the `ready` frame; **appended** on `channel.create`, **deduped
  by `id`** (the creator's own socket + the 201 REST response can both deliver a
  channel — only one entry results).
- **Reactive.** Reading `gateway.channels` inside a `$derived`/`$effect`/template
  re-runs when channels change.
- **Cleared** on `gateway.disconnect()` (logout / unmount).

## The active-selection store (the provided API)

`channelStore` (`client/src/lib/channelStore.svelte.ts`) — a runes singleton that
holds **only the selected channel id** (the stable identity). Import and read
fields directly:

```ts
import { channelStore } from "./channelStore.svelte";

channelStore.activeId; // number | null  — getter, the currently selected channel id
channelStore.select(id: number): void;   // mark a channel active
channelStore.clear(): void;               // reset selection (logout / session-invalid)
```

- `activeId` starts `null`. Story 004's `Presence.svelte` selects a sensible
  **default** (the first text channel by sort order) via an `$effect` once
  `gateway.channels` is non-empty and `activeId` is still `null`.
- `select(id)` is called on user click and immediately after a successful
  create (the just-created channel becomes active).
- `clear()` is invoked by `App.svelte` on logout and on a 4001/session-invalid
  teardown, so a re-login starts with no stale selection.

## How the message pane reads the active channel (story 005)

The store holds only the id; resolve the full channel object from the gateway:

```ts
import { gateway } from "./gateway.svelte";
import { channelStore } from "./channelStore.svelte";

const activeChannel = $derived(
  gateway.channels.find((c) => c.id === channelStore.activeId) ?? null,
);
```

- `activeChannel` is `null` when no channel is selected (e.g. empty server before
  any channel exists). Story 005 should render an empty/placeholder state then.
- Use `channelStore.activeId` as the key for fetching history
  (`GET /api/channels/:id/messages`, story 003) and as the channel to target when
  sending messages (story 002 gateway op). Re-fetch when `activeId` changes.

## Notes for consumers

- Do **not** mutate `gateway.channels` or assume it includes voice channels.
- The selection is **id-based**, not object-based — a channel object is a fresh
  reference after each `ready`/`channel.create` (Map reassign), so compare by `id`.
- No persistence: `activeId` is in-memory only and resets on logout.
