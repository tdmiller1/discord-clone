/**
 * Reactive WebSocket gateway (Svelte 5 runes). Lives in a *.svelte.ts module so
 * $state/$derived work outside a component, and so the socket survives component
 * re-renders and has one teardown point (mirrors authStore.svelte.ts).
 *
 * Owns the WS lifecycle (connect → identify → ready/presence.update → reconnect or
 * teardown) and the reactive presence Map per the story-004 ws-protocol contract:
 * connect to /ws (ws/wss derived from store.serverUrl), send { op:"identify", d:{token} }
 * first, seed members from `ready`, mutate on `presence.update`, treat close 4001 as an
 * auth failure (no reconnect — App clears the session + returns to login), and reconnect
 * with capped exponential backoff on any other unexpected close.
 *
 * It does NOT touch the keychain or the view — the 4001 auth failure is surfaced as a
 * one-shot reactive `authFailed` flag that App reacts to, keeping the session-clear +
 * view switch co-located with the rest of App's session handling.
 */
import { store } from "./authStore.svelte";
import type { Member, PublicChannel, ServerFrame } from "./types";

type ConnStatus = "connecting" | "open" | "reconnecting" | "closed";

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const AUTH_FAILURE_CODE = 4001;
const WS_PATH = "/ws";

let _members = $state(new Map<number, Member>());
let _channels = $state(new Map<number, PublicChannel>());
let _status = $state<ConnStatus>("closed");
let _authFailed = $state(false);

/** Map values sorted online-first, then by username (case-insensitive) for stable display. */
const _memberList = $derived(
  [..._members.values()].sort((a, b) => {
    if (a.status !== b.status) return a.status === "online" ? -1 : 1;
    return a.username.localeCompare(b.username, undefined, { sensitivity: "base" });
  }),
);

/** Text channels only (voice is M4), sorted by position then id for a stable list. */
const _channelList = $derived(
  [..._channels.values()]
    .filter((c) => c.type === "text")
    .sort((a, b) => a.position - b.position || a.id - b.id),
);

// Non-reactive module locals (deliberately NOT $state).
let socket: WebSocket | null = null;
let intentional = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = BACKOFF_BASE_MS;

/** Derive the ws(s):// gateway URL from the stored http(s) server base. */
function wsUrl(): string {
  const u = new URL(store.serverUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = WS_PATH;
  return u.toString();
}

/** True for a frame that is an object carrying a string `op`. */
function isServerFrame(value: unknown): value is ServerFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { op?: unknown }).op === "string"
  );
}

function handleFrame(frame: ServerFrame): void {
  switch (frame.op) {
    case "ready": {
      const next = new Map<number, Member>();
      for (const member of frame.d.members) next.set(member.id, member);
      _members = next;
      const nextChannels = new Map<number, PublicChannel>();
      for (const channel of frame.d.channels) nextChannels.set(channel.id, channel);
      _channels = nextChannels;
      _status = "open";
      backoffMs = BACKOFF_BASE_MS; // a clean (re)connect resets the backoff
      break;
    }
    case "presence.update": {
      const existing = _members.get(frame.d.userId);
      if (!existing) break; // unknown userId — ignore safely
      _members.set(frame.d.userId, { ...existing, status: frame.d.status });
      // Svelte 5 Maps aren't deeply reactive — reassign to recompute the derived list.
      _members = new Map(_members);
      break;
    }
    case "channel.create": {
      // Dedupe by id (the creator's own socket + the 201 response can both deliver it).
      _channels.set(frame.d.channel.id, frame.d.channel);
      _channels = new Map(_channels); // reassign to recompute the derived list
      break;
    }
    default:
      break; // unknown op — ignore
  }
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (intentional || store.sessionToken === null) return;
  clearReconnectTimer();
  const delay = backoffMs * (0.5 + Math.random() * 0.5); // 50–100% jitter
  reconnectTimer = setTimeout(open, delay);
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

function open(): void {
  if (store.sessionToken === null) {
    _status = "closed";
    return;
  }
  _status = reconnectTimer !== null ? "reconnecting" : "connecting";
  reconnectTimer = null;

  const ws = new WebSocket(wsUrl());
  socket = ws;

  ws.onopen = () => {
    const token = store.sessionToken;
    if (token === null) return; // raced with a logout — nothing to identify with
    // Send identify as the first frame (server auth deadline is 10s). Stay "connecting"
    // until `ready` arrives — a bad token closes with 4001 before any frame.
    ws.send(JSON.stringify({ op: "identify", d: { token } }));
  };

  ws.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return; // not JSON — ignore
    }
    if (isServerFrame(parsed)) handleFrame(parsed);
  };

  ws.onclose = (event) => {
    if (socket !== ws) return; // a stale socket we already replaced — ignore
    socket = null;
    if (intentional) {
      _status = "closed";
      return;
    }
    if (event.code === AUTH_FAILURE_CODE) {
      // Session is dead (invalid/expired/revoked/disabled). Do NOT reconnect with the
      // same dead token; App clears the session + returns to login on this flag.
      _authFailed = true;
      _status = "closed";
      return;
    }
    _status = "reconnecting";
    scheduleReconnect();
  };

  ws.onerror = () => {
    // The following `onclose` drives reconnect/auth handling — nothing to do here.
  };
}

/** The reactive WS gateway singleton. Read fields directly (e.g. gateway.members). */
export const gateway = {
  /** Members sorted online-first then by username, recomputed on every presence change. */
  get members(): Member[] {
    return _memberList;
  },
  /** Text channels sorted by position then id, seeded from `ready` + appended on `channel.create`. */
  get channels(): PublicChannel[] {
    return _channelList;
  },
  /** Connection status for the UI status line. */
  get status(): ConnStatus {
    return _status;
  },
  /** One-shot 4001 auth-failure signal for App (cleared via clearAuthFailed). */
  get authFailed(): boolean {
    return _authFailed;
  },

  /** Open the socket and (re)start the lifecycle with a fresh backoff. */
  connect(): void {
    intentional = false;
    clearReconnectTimer();
    backoffMs = BACKOFF_BASE_MS;
    open();
  },

  /** Intentional teardown (logout / unmount): stop reconnecting and close cleanly. */
  disconnect(): void {
    intentional = true;
    clearReconnectTimer();
    _members = new Map();
    _channels = new Map();
    _status = "closed";
    const ws = socket;
    socket = null;
    ws?.close(1000);
  },

  /** App calls this after routing to login so a fresh login + reconnect starts clean. */
  clearAuthFailed(): void {
    _authFailed = false;
  },
};
