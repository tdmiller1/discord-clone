/**
 * Session-token persistence so a relaunch stays signed in (SPEC.md §6/§12).
 * Never stores the password — only the opaque session token.
 *
 * Desktop (Tauri): the OS keychain via the Rust shell — the most secure store
 * available on the platform.
 *
 * Web (plain browser, no Tauri): localStorage, so a browser tab also stays signed
 * in across relaunches instead of forcing a fresh login every time. The session is
 * good for up to the server's 7-day TTL — App.bootstrap() validates and rotates the
 * token on each launch, so it keeps sliding forward as long as you return within
 * that window. The same store already holds the server URL (config.ts); the session
 * token is the only added secret, which is acceptable for this self-hosted,
 * ≤10-trusted-user deployment.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

const SESSION_KEY = "dc:session";

/** Read the stored session token, or null if none. */
export async function getSession(): Promise<string | null> {
  if (isTauri()) return (await invoke<string | null>("get_session")) ?? null;
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null; // storage blocked/unavailable
  }
}

/** Persist the session token (OS keychain under Tauri, localStorage in the browser). */
export async function setSession(token: string): Promise<void> {
  if (isTauri()) {
    await invoke("set_session", { token });
    return;
  }
  try {
    localStorage.setItem(SESSION_KEY, token);
  } catch {
    // storage blocked/unavailable — degrade to an in-memory-only session
  }
}

/** Remove the stored session token; idempotent. */
export async function deleteSession(): Promise<void> {
  if (isTauri()) {
    await invoke("delete_session");
    return;
  }
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // nothing persisted — nothing to clear
  }
}
