import { Database } from "bun:sqlite";
import { migrations } from "./migrations.ts";
import type { CtxPaths } from "../paths.ts";
import { ensureHome } from "../config.ts";

/**
 * Opens the SQLite database at `paths.dbFile`, creating the ctx home directory
 * if needed and applying any pending migrations. Safe to call repeatedly.
 */
export function openDatabase(paths: CtxPaths): Database {
  ensureHome(paths);
  const db = new Database(paths.dbFile, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  return db;
}

/** Open an in-memory database (used by tests that don't need persistence). */
export function openMemoryDatabase(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  return db;
}

function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRow = db
    .query<{ v: number | null }, []>("SELECT MAX(version) AS v FROM schema_migrations")
    .get();
  const current = appliedRow?.v ?? 0;

  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    const tx = db.transaction(() => {
      db.exec(migration.sql);
      db.query(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, new Date().toISOString());
    });
    tx();
  }
}
