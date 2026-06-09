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
import type { Member, PublicChannel, PublicMessage, ServerFrame } from "./types";

type ConnStatus = "connecting" | "open" | "reconnecting" | "closed";

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const AUTH_FAILURE_CODE = 4001;
const WS_PATH = "/ws";

let _members = $state(new Map<number, Member>());
let _channels = $state(new Map<number, PublicChannel>());
let _messages = $state(new Map<number, Map<number, PublicMessage>>());
let _status = $state<ConnStatus>("closed");
let _authFailed = $state(false);

/** Map values sorted online-first, then by username (case-insensitive) for stable display. */
const _memberList = $derived(
  [..._members.values()].sort((a, b) => {
    if (a.status !== b.status) return a.status === "online" ? -1 : 1;
    return a.username.localeCompare(b.username, undefined, { sensitivity: "base" });
  }),
);

/** Text channels only, sorted by position then id for a stable list. */
const _channelList = $derived(
  [..._channels.values()]
    .filter((c) => c.type === "text")
    .sort((a, b) => a.position - b.position || a.id - b.id),
);

/** Voice channels only (M4), parallel to _channelList so text consumers stay text-only. */
const _voiceChannelList = $derived(
  [..._channels.values()]
    .filter((c) => c.type === "voice")
    .sort((a, b) => a.position - b.position || a.id - b.id),
);

// Non-reactive module locals (deliberately NOT $state).
let socket: WebSocket | null = null;
let intentional = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = BACKOFF_BASE_MS;

// Voice seam (M4): the voice engine rides this same socket. It registers an inbound `voice.*`
// frame route + a teardown signal here so we never open a second WS and the dependency stays
// one-directional (voice → gateway).
let voiceFrameHandler: ((frame: ServerFrame) => void) | null = null;
let voiceTeardownHandler: (() => void) | null = null;

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

/** Upsert one message into its channel's id-keyed map (dedupe by id), then reassign the
 * outer map so derived reads recompute (Svelte 5 Maps aren't deeply reactive). */
function upsertMessage(channelId: number, msg: PublicMessage): void {
  const inner = _messages.get(channelId) ?? new Map<number, PublicMessage>();
  inner.set(msg.id, msg);
  _messages.set(channelId, inner);
  _messages = new Map(_messages);
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
      _members.set(frame.d.userId, {
        ...existing,
        status: frame.d.status,
        voiceChannelId: frame.d.voiceChannelId, // thread voice membership for the "who's in voice" set
      });
      // Svelte 5 Maps aren't deeply reactive — reassign to recompute the derived list.
      _members = new Map(_members);
      break;
    }
    case "user.update": {
      // A profile change (e.g. username). Overlay the new PublicUser fields, keeping
      // the member's live presence (status/voiceChannelId). Seed an offline entry if
      // we somehow don't know this user yet (shouldn't happen — `ready` lists all).
      const u = frame.d.user;
      const existing = _members.get(u.id);
      _members.set(u.id, {
        ...u,
        status: existing?.status ?? "offline",
        voiceChannelId: existing?.voiceChannelId ?? null,
      });
      _members = new Map(_members); // reassign to recompute the derived list + author names
      break;
    }
    case "channel.create": {
      // Dedupe by id (the creator's own socket + the 201 response can both deliver it).
      _channels.set(frame.d.channel.id, frame.d.channel);
      _channels = new Map(_channels); // reassign to recompute the derived list
      break;
    }
    case "message.create": {
      // Upsert by id — a history/live race renders each message once.
      upsertMessage(frame.d.message.channelId, frame.d.message);
      break;
    }
    default:
      // Route voice.* frames to the voice engine if it has registered (single /ws socket);
      // any other unknown op is ignored.
      if (frame.op.startsWith("voice.")) voiceFrameHandler?.(frame);
      break;
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
      voiceTeardownHandler?.(); // release mic + transports — the socket is gone
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
  /** Voice channels sorted by position then id — a parallel surface to `channels` (which stays
   * text-only) so voice is a separate control and never enters the message-pane selection path. */
  get voiceChannels(): PublicChannel[] {
    return _voiceChannelList;
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
    voiceTeardownHandler?.(); // release mic + transports from the one socket-teardown point
    clearReconnectTimer();
    _members = new Map();
    _channels = new Map();
    _messages = new Map();
    _status = "closed";
    const ws = socket;
    socket = null;
    ws?.close(1000);
  },

  /** App calls this after routing to login so a fresh login + reconnect starts clean. */
  clearAuthFailed(): void {
    _authFailed = false;
  },

  /** A channel's cached messages, sorted ascending by id (oldest→newest) for display. */
  messagesFor(channelId: number): PublicMessage[] {
    return [...(_messages.get(channelId)?.values() ?? [])].sort((a, b) => a.id - b.id);
  },

  /** Ingest a page of history (or load-older results), upserting each by id (dedupes
   * against any live message.create already cached) in a single outer-map reassign. */
  prependHistory(channelId: number, msgs: PublicMessage[]): void {
    if (msgs.length === 0) return;
    const inner = _messages.get(channelId) ?? new Map<number, PublicMessage>();
    for (const msg of msgs) inner.set(msg.id, msg);
    _messages.set(channelId, inner);
    _messages = new Map(_messages);
  },

  /** Send a message over the WS for a channel. Fire-and-forget — the server broadcasts
   * message.create back to the sender, so no optimistic insert is needed. Pass an optional
   * positive-integer `attachmentId` to attach an uploaded image (story 003); it is included
   * in the frame only when valid, so the plain-text path stays the M2 frame. */
  sendMessage(channelId: number, content: string, attachmentId?: number): void {
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    const d: { channelId: number; content: string; attachmentId?: number } = {
      channelId,
      content,
    };
    if (Number.isInteger(attachmentId) && attachmentId! > 0) d.attachmentId = attachmentId;
    socket.send(JSON.stringify({ op: "message.send", d }));
  },

  /** Send a voice.* op over the existing gateway socket (the voice engine's only send path —
   * no second WebSocket). Guards readyState; returns whether the frame was actually sent so the
   * engine can fail a join if the socket dropped. Mirrors sendMessage's guard. */
  sendVoice(op: string, d: unknown): boolean {
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ op, d }));
    return true;
  },

  /** Register the voice engine's inbound voice.* frame route (called once at its module load). */
  onVoiceFrame(handler: (frame: ServerFrame) => void): void {
    voiceFrameHandler = handler;
  },

  /** Register a teardown the gateway fires on disconnect() + 4001 so a dropped/auth-failed
   * socket releases the mic + transports from one place. */
  onVoiceTeardown(handler: () => void): void {
    voiceTeardownHandler = handler;
  },
};
