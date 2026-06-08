/**
 * Default server URL shown on first launch. The admin overrides this per deployment.
 * Baked in at build time via VITE_SERVER_URL (set for the hosted web image so it
 * targets the public API); Tauri and `npm run dev` builds leave it unset and fall
 * back to localhost. Users can still change it on the login/register screen.
 */
export const DEFAULT_SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:8080";

/**
 * Public URL of the hosted web client, used to build shareable invite links.
 * Baked at build time via VITE_APP_URL (set for the hosted web image so links
 * point at the public app, e.g. https://app.example.com); when unset (desktop /
 * `npm run dev`) it falls back to the current page origin. The invite link only
 * needs to reach the hosted web client — that bundle already has the public server
 * URL baked in (VITE_SERVER_URL), so the friend connects to the right backend.
 */
export const APP_BASE_URL =
  import.meta.env.VITE_APP_URL ||
  (typeof window !== "undefined" ? window.location.origin : "");

/** Build a shareable, single-use invite link carrying the token the new client auto-fills. */
export function inviteLink(token: string): string {
  const base = APP_BASE_URL.replace(/\/+$/, "");
  return `${base}/?invite=${encodeURIComponent(token)}`;
}

const SERVER_URL_KEY = "dc:serverUrl";

/** Read the persisted server URL, falling back to DEFAULT_SERVER_URL if unset/unavailable. */
export function getStoredServerUrl(): string {
  try {
    return localStorage.getItem(SERVER_URL_KEY) ?? DEFAULT_SERVER_URL;
  } catch {
    return DEFAULT_SERVER_URL;
  }
}

/** Persist the chosen server URL so it survives relaunch (no-op if storage is unavailable). */
export function setStoredServerUrl(url: string): void {
  try {
    localStorage.setItem(SERVER_URL_KEY, url);
  } catch {
    // storage blocked/unavailable — degrade silently to the default seed
  }
}
