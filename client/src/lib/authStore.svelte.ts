/**
 * Reactive auth/session store (Svelte 5 runes). Lives in a *.svelte.ts module so
 * $state/$derived work outside a component. Exposes the current user, raw session
 * token, persisted server URL, and expiry, plus a derived isAuthed flag and the
 * applySession / setServerUrl / clear mutators. Documented in
 * contracts/client-session.md for story 007 (which reads it to open the WS).
 *
 * The store does NOT touch the keychain itself — callers pair applySession/clear
 * with setSession/deleteSession so the keychain side effect stays explicit.
 */
import { getStoredServerUrl, setStoredServerUrl } from "./config";
import type { PublicUser, SessionResponse } from "./types";

let _currentUser = $state<PublicUser | null>(null);
let _sessionToken = $state<string | null>(null);
let _serverUrl = $state<string>(getStoredServerUrl());
let _expiresAt = $state<number | null>(null);

const _isAuthed = $derived(_sessionToken !== null && _currentUser !== null);

/** The reactive auth/session singleton. Read fields directly (e.g. store.sessionToken). */
export const store = {
  get currentUser(): PublicUser | null {
    return _currentUser;
  },
  get sessionToken(): string | null {
    return _sessionToken;
  },
  get serverUrl(): string {
    return _serverUrl;
  },
  get expiresAt(): number | null {
    return _expiresAt;
  },
  get isAuthed(): boolean {
    return _isAuthed;
  },

  /** Set user/token/expiry after a successful register, login, or refresh. */
  applySession(body: SessionResponse): void {
    _currentUser = body.user;
    _sessionToken = body.session;
    _expiresAt = body.expiresAt;
  },

  /** Update the server URL and persist it to localStorage. */
  setServerUrl(url: string): void {
    _serverUrl = url;
    setStoredServerUrl(url);
  },

  /** Wipe user/token/expiry (keeps serverUrl so login remembers the server). */
  clear(): void {
    _currentUser = null;
    _sessionToken = null;
    _expiresAt = null;
  },
};
