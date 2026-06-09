import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { ensureBootstrapToken } from "./tokens.js";

const config = loadConfig();
const app = await buildApp(config);

// First-run bootstrap: with no users yet, mint + print a single-use invite token
// so the first account can register without a separate `server mint-token` call
// (SPEC.md §6). No-op once anyone has registered.
const bootstrapToken = ensureBootstrapToken(app.db);
if (bootstrapToken) {
  app.log.info(
    { inviteToken: bootstrapToken },
    `no users yet — bootstrap invite token (single-use): ${bootstrapToken}`,
  );
}

try {
  const address = await app.listen({ host: "0.0.0.0", port: config.httpPort });
  app.log.info(`discord-clone-server listening on ${address}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info(`received ${signal}, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}
