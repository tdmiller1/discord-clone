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
  };
}
