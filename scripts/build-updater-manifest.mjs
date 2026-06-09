// Assemble the Tauri updater manifest (latest.json) for a tagged release.
//
// CI (.github/workflows/ci.yml, release-updater-manifest job) downloads every *.sig asset
// attached to the release into a directory, then runs this. Each signature file is named
// `<installer>.sig`, so the installer asset name — and thus its public download URL — is the
// signature filename minus `.sig`; the signature value is the file's contents. That's all the
// updater needs, so we never have to query the release's asset list separately.
//
// The desktop client polls the resulting latest.json (plugins.updater.endpoints in
// tauri.conf.json) and compares its version, then downloads the matching platform installer.
//
// Env: GITHUB_REPOSITORY (owner/repo), GITHUB_REF_NAME (the v* tag), SIGS_DIR (default "sigs").
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const repo = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME;
const sigsDir = process.env.SIGS_DIR ?? "sigs";
if (!repo || !tag) {
  console.error("GITHUB_REPOSITORY and GITHUB_REF_NAME are required");
  process.exit(1);
}

const version = tag.replace(/^v/, "");
const sigFiles = readdirSync(sigsDir).filter((f) => f.endsWith(".sig"));

/** Resolve the {signature, url} for the installer whose name ends in `suffix` (e.g. ".AppImage"). */
function assetFor(suffix) {
  const sig = sigFiles.find((f) => f.endsWith(`${suffix}.sig`));
  if (!sig) return null;
  const asset = sig.slice(0, -".sig".length);
  return {
    signature: readFileSync(`${sigsDir}/${sig}`, "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(asset)}`,
  };
}

// Tauri updater platform keys → the installer that self-updates that platform.
// Linux: the AppImage itself. Windows: the NSIS installer (`-setup.exe`).
const platforms = {};
const linux = assetFor(".AppImage");
const windows = assetFor("-setup.exe");
if (linux) platforms["linux-x86_64"] = linux;
if (windows) platforms["windows-x86_64"] = windows;

const missing = ["linux-x86_64", "windows-x86_64"].filter((k) => !platforms[k]);
if (missing.length) {
  console.error(
    `Missing updater artifact(s) for: ${missing.join(", ")}. ` +
      `Found signatures: ${sigFiles.join(", ") || "(none)"}`,
  );
  process.exit(1);
}

const manifest = { version, pub_date: new Date().toISOString(), platforms };
writeFileSync("latest.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
