/// <reference types="svelte" />
/// <reference types="vite/client" />

/** Client version injected at build time from package.json (see vite.config.ts). */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Build-time default server URL for the hosted web client (see lib/config.ts). */
  readonly VITE_SERVER_URL?: string;
  /** Build-time public URL of the hosted web client, used to build invite links (see lib/config.ts). */
  readonly VITE_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
