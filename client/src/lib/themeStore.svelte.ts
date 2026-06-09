/**
 * Per-user color customization (Svelte 5 runes). Lets a user override the four
 * core theme CSS variables — background, foreground/surface, the blue highlight
 * (accent), and the text color used on those backgrounds — and persists the
 * choices to localStorage so they survive a relaunch.
 *
 * This is purely client-side and per-device: there is no server-side theme in
 * SPEC, so it lives alongside the other local preferences (remembered server
 * URL in config.ts, session token in session.ts) rather than syncing.
 *
 * Overrides are applied by writing the custom properties onto
 * document.documentElement, which wins over the :root defaults in app.css.
 * Resetting a color removes the inline property so it falls back to that
 * built-in default. The module loads + applies any stored overrides at import
 * time (see the bottom of the file) so there's no flash of the default theme.
 */

export type ThemeKey = "bg" | "surface" | "accent" | "text";

export interface ThemeColor {
  key: ThemeKey;
  /** The CSS custom property this drives (must match app.css :root). */
  cssVar: string;
  /** Human label shown in the profile editor. */
  label: string;
  /** Short hint describing what the color affects. */
  hint: string;
  /** Built-in default — kept in sync with app.css :root. */
  default: string;
}

// Order here is the order shown in the editor.
export const THEME_COLORS: ThemeColor[] = [
  { key: "bg", cssVar: "--bg", label: "Background", hint: "App background", default: "#1e1f22" },
  {
    key: "surface",
    cssVar: "--surface",
    label: "Foreground",
    hint: "Panels & cards",
    default: "#2b2d31",
  },
  {
    key: "accent",
    cssVar: "--accent",
    label: "Highlight",
    hint: "Buttons & active items",
    default: "#5865f2",
  },
  { key: "text", cssVar: "--text", label: "Text", hint: "Text on backgrounds", default: "#dbdee1" },
];

const BY_KEY: Record<ThemeKey, ThemeColor> = Object.fromEntries(
  THEME_COLORS.map((c) => [c.key, c]),
) as Record<ThemeKey, ThemeColor>;

const STORAGE_KEY = "dc:theme";

// `<input type="color">` only ever emits 6-digit lowercase hex; we reject
// anything else so a corrupted localStorage value can't inject arbitrary CSS.
const HEX_RE = /^#[0-9a-f]{6}$/i;

function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

// Persisted overrides: only the keys the user has actually changed. A missing
// key means "use the app.css default".
let _overrides = $state<Partial<Record<ThemeKey, string>>>({});

/** Apply (or, when value is undefined, clear) one variable on <html>. */
function applyVar(color: ThemeColor, value: string | undefined): void {
  if (typeof document === "undefined") return; // non-browser (e.g. SSR/tests)
  const root = document.documentElement;
  if (value === undefined) root.style.removeProperty(color.cssVar);
  else root.style.setProperty(color.cssVar, value);
}

function persist(): void {
  try {
    if (Object.keys(_overrides).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(_overrides));
  } catch {
    // storage blocked/unavailable — overrides stay in-memory for this session
  }
}

/** Read stored overrides (validating each), apply them, and seed the store. */
function load(): void {
  let stored: unknown;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    stored = JSON.parse(raw);
  } catch {
    return; // unreadable/blocked storage or bad JSON — fall back to defaults
  }
  if (stored === null || typeof stored !== "object") return;

  const next: Partial<Record<ThemeKey, string>> = {};
  for (const color of THEME_COLORS) {
    const value = (stored as Record<string, unknown>)[color.key];
    if (isHex(value)) {
      next[color.key] = value.toLowerCase();
      applyVar(color, value.toLowerCase());
    }
  }
  _overrides = next;
}

export const theme = {
  /** The current color for a key — the override if set, else the default. */
  color(key: ThemeKey): string {
    return _overrides[key] ?? BY_KEY[key].default;
  },

  /** Whether the user has overridden this color. */
  isOverridden(key: ThemeKey): boolean {
    return _overrides[key] !== undefined;
  },

  /** Whether any color has been customized (drives the "Reset all" affordance). */
  anyOverridden(): boolean {
    return Object.keys(_overrides).length > 0;
  },

  /** Set a color override (ignores invalid hex), apply it live, and persist. */
  set(key: ThemeKey, value: string): void {
    if (!isHex(value)) return;
    const normalized = value.toLowerCase();
    _overrides = { ..._overrides, [key]: normalized };
    applyVar(BY_KEY[key], normalized);
    persist();
  },

  /** Clear one override, reverting to the built-in default. */
  reset(key: ThemeKey): void {
    if (_overrides[key] === undefined) return;
    const { [key]: _dropped, ...rest } = _overrides;
    _overrides = rest;
    applyVar(BY_KEY[key], undefined);
    persist();
  },

  /** Clear every override at once. */
  resetAll(): void {
    for (const color of THEME_COLORS) applyVar(color, undefined);
    _overrides = {};
    persist();
  },
};

// Apply any persisted overrides as soon as this module is first imported, before
// the first paint, to avoid a flash of the default theme.
load();
