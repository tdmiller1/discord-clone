/**
 * Background auto-updater for the desktop (Tauri) client.
 *
 * Every 60s it asks Tauri's updater plugin whether a newer signed release exists at the
 * configured endpoint (plugins.updater in tauri.conf.json). When one does, it downloads +
 * signature-verifies + installs it in place, then relaunches into the new version.
 *
 * Two deliberate behaviours:
 *  - Outside Tauri (the hosted web build) startAutoUpdate() is a no-op — same isTauri()
 *    guard as lib/session.ts — so the browser bundle never touches the plugin APIs.
 *  - The relaunch is deferred while the user is in the voice channel so an update never
 *    drops a live call; once installed we retry the relaunch each tick until they leave.
 */
import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { voice } from "./voice.svelte";

const POLL_INTERVAL_MS = 60_000;

let started = false; // startAutoUpdate is idempotent — only ever one interval
let inFlight = false; // a check/download is running — don't start a second
let applied = false; // update installed on disk; we're only waiting to relaunch

/** True while the user is connected to (or joining) the voice channel. */
function inVoiceCall(): boolean {
  return voice.voiceChannelId !== null;
}

/** Relaunch now, unless a call is active — in which case a later tick retries. */
async function maybeRelaunch(): Promise<void> {
  if (inVoiceCall()) return; // defer; the next poll re-checks and relaunches when idle
  await relaunch();
}

/** One poll cycle: check → (download+install) → relaunch. Never throws. */
async function tick(): Promise<void> {
  if (applied) return maybeRelaunch(); // already installed, just waiting to restart
  if (inFlight) return; // a long download is still running
  inFlight = true;
  try {
    const update = await check();
    if (update?.available) {
      await update.downloadAndInstall(); // streams the artifact, verifies the signature, installs
      applied = true;
      await maybeRelaunch();
    }
  } catch {
    // Offline, endpoint unreachable, or a dev build without an updater endpoint —
    // swallow and try again next interval. Auto-update is best-effort, never fatal.
  } finally {
    inFlight = false;
  }
}

/**
 * Begin polling for updates. No-op outside Tauri (web build) and idempotent, so it's safe
 * to call once on app startup. Runs an immediate check, then every POLL_INTERVAL_MS.
 */
export function startAutoUpdate(): void {
  if (started || !isTauri()) return;
  started = true;
  void tick();
  setInterval(() => void tick(), POLL_INTERVAL_MS);
}
