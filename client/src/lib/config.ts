/** Default server URL shown on first launch. The admin overrides this per deployment. */
export const DEFAULT_SERVER_URL = "http://localhost:8080";

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
