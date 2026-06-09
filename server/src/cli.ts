#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { openDatabase, type Db } from "./db.js";
import { mintToken } from "./tokens.js";

const USAGE = `Usage: server <command> [args]

Commands:
  mint-token              Generate a single-use invite token (prints the raw token once)
  revoke-user <username>  Disable a user and revoke all of their sessions
  revoke-token <id>       Revoke an unused invite token by id
  --help, -h              Show this help`;

function mintTokenCommand(db: Db): void {
  console.log(mintToken(db));
}

function revokeUser(db: Db, username: string | undefined): void {
  if (!username) {
    console.error("usage: server revoke-user <username>");
    process.exitCode = 1;
    return;
  }
  const row = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
    | { id: number }
    | undefined;
  if (!row) {
    console.error(`unknown user: ${username}`);
    process.exitCode = 1;
    return;
  }
  const revokeAll = db.transaction((userId: number) => {
    db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(userId);
    const res = db
      .prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0")
      .run(userId);
    return res.changes;
  });
  const sessionsRevoked = revokeAll(row.id);
  console.log(
    `revoked user "${username}" (disabled account, ${sessionsRevoked} session(s) revoked)`,
  );
}

function revokeToken(db: Db, idArg: string | undefined): void {
  const id = Number(idArg);
  if (!idArg || !Number.isInteger(id) || id <= 0) {
    console.error("usage: server revoke-token <id>");
    process.exitCode = 1;
    return;
  }
  const res = db
    .prepare(
      "UPDATE invite_tokens SET revoked = 1 WHERE id = ? AND used_by IS NULL AND revoked = 0",
    )
    .run(id);
  if (res.changes === 0) {
    console.error(`no unused invite token with id ${id}`);
    process.exitCode = 1;
    return;
  }
  console.log(`revoked invite token ${id}`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (command === undefined) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (command !== "mint-token" && command !== "revoke-user" && command !== "revoke-token") {
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const db = openDatabase(loadConfig());
  try {
    switch (command) {
      case "mint-token":
        mintTokenCommand(db);
        break;
      case "revoke-user":
        revokeUser(db, argv[1]);
        break;
      case "revoke-token":
        revokeToken(db, argv[1]);
        break;
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
