import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { applySchema } from "./schema.js";

/** The opened SQLite handle. Re-exported so downstream modules can type the handle without importing better-sqlite3. */
export type Db = Database.Database;

/**
 * Opens (creating if needed) the single SQLite file at `<config.dataDir>/app.db`,
 * applies the M1 schema and returns the handle. The shared factory consumed by
 * both {@link ./app.ts buildApp} and the admin CLI (story 002) so there is no
 * global singleton — each entry point opens against the same file (SPEC.md §8).
 *
 * Pragmas: WAL for concurrent readers alongside the occasional CLI writer, and
 * foreign-key enforcement (off by default in better-sqlite3).
 */
export function openDatabase(config: Config): Db {
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Database(join(config.dataDir, "app.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}
