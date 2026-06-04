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

export function loadConfig(): Config {
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    httpPort: num("HTTP_PORT", 8080),
    dataDir: process.env.DATA_DIR ?? "./data",
    publicHost: process.env.PUBLIC_HOST ?? "localhost",
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
