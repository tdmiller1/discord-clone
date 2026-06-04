/**
 * Session-token persistence backed by the OS keychain via the Tauri Rust shell.
 * Stores the opaque session token only — never the password (SPEC.md §6/§12).
 * In the plain-browser dev path (no Tauri), every call short-circuits:
 * getSession() -> null, setSession/deleteSession -> no-op.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

/** Read the stored session token, or null if none / not running under Tauri. */
export async function getSession(): Promise<string | null> {
  if (!isTauri()) return null;
  return (await invoke<string | null>("get_session")) ?? null;
}

/** Persist the session token in the OS keychain (no-op outside Tauri). */
export async function setSession(token: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_session", { token });
}

/** Remove the stored session token; idempotent (no-op outside Tauri). */
export async function deleteSession(): Promise<void> {
  if (!isTauri()) return;
  await invoke("delete_session");
}
