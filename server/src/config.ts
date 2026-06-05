import { join } from "node:path";

/**
 * Runtime configuration, loaded from environment variables.
 * See SPEC.md §12 for the canonical list and deployment notes.
 */
export interface Config {
  nodeEnv: string;
  httpPort: number;
  /** Directory for the SQLite file and uploaded images (mounted volume in Docker). */
  dataDir: string;
  /** Public hostname/IP advertised to clients (used as the WebRTC ICE announce address in M4). */
  publicHost: string;
  /**
   * Every IP the SFU advertises as an ICE candidate: the public host plus any extra
   * announced IPs from RTC_EXTRA_ANNOUNCED_IPS (e.g. the server's LAN IP, so clients
   * on the same network connect directly instead of hairpinning the public IP).
   */
  rtcAnnouncedIps: string[];
  /** UDP media port range for the SFU (M4). */
  rtcMinPort: number;
  rtcMaxPort: number;
  /** Max accepted image upload size, in megabytes. */
  maxUploadMb: number;
  /** Session lifetime, in seconds. */
  sessionTtlSeconds: number;
  /** Max register/login requests per IP per rate-limit window. */
  authRateMax: number;
  /** Rate-limit window length for the auth endpoints, in milliseconds. */
  authRateWindowMs: number;
  /** Max accepted message content length, in characters. */
  maxMessageLength: number;
  /** Default page size for message history when no limit is supplied. */
  messageHistoryDefaultLimit: number;
  /** Hard cap on the message-history page size; larger requests are clamped. */
  messageHistoryMaxLimit: number;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${name}: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Parses a comma-separated env var into a trimmed, de-duplicated, non-empty list. */
function csv(name: string): string[] {
  const raw = process.env[name];
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Image MIME types accepted by the upload route (SPEC.md §10). Determined by
 * byte-sniffing the upload, never the client-supplied Content-Type/filename.
 */
export const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/** Resolves the on-disk directory for uploaded images: `<dataDir>/images`. */
export function imagesDir(config: Config): string {
  return join(config.dataDir, "images");
}

export function loadConfig(): Config {
  const publicHost = process.env.PUBLIC_HOST ?? "localhost";
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    httpPort: num("HTTP_PORT", 8080),
    dataDir: process.env.DATA_DIR ?? "./data",
    publicHost,
    rtcAnnouncedIps: [...new Set([publicHost, ...csv("RTC_EXTRA_ANNOUNCED_IPS")])],
    rtcMinPort: num("RTC_MIN_PORT", 40000),
    rtcMaxPort: num("RTC_MAX_PORT", 40100),
    maxUploadMb: num("MAX_UPLOAD_MB", 10),
    sessionTtlSeconds: num("SESSION_TTL", 60 * 60 * 24 * 7),
    authRateMax: num("AUTH_RATE_MAX", 10),
    authRateWindowMs: num("AUTH_RATE_WINDOW_MS", 60_000),
    maxMessageLength: num("MAX_MESSAGE_LENGTH", 4000),
    messageHistoryDefaultLimit: num("MSG_HISTORY_DEFAULT_LIMIT", 50),
    messageHistoryMaxLimit: num("MSG_HISTORY_MAX_LIMIT", 100),
  };
}
