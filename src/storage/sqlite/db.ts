import { openDb, type Database } from "./driver.ts";
import { migrations } from "./migrations.ts";
import { withWriteTx } from "./tx.ts";
import type { CtxPaths } from "../paths.ts";
import { ensureHome } from "../config.ts";
import { withFileLock } from "../../utils/fs.ts";

const LATEST_VERSION = migrations.reduce((m, x) => Math.max(m, x.version), 0);

/** How long a connection waits for a lock before giving up (ms). */
const BUSY_TIMEOUT_MS = 10000;

function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function isBusy(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    (typeof e?.code === "string" && e.code.includes("BUSY")) ||
    (typeof e?.message === "string" && /database is locked|SQLITE_BUSY/i.test(e.message))
  );
}

/**
 * Opens the SQLite database at `paths.dbFile`, creating the ctx home directory
 * if needed and applying any pending migrations. Safe to call from many
 * processes at once (see `runMigrations`).
 */
export function openDatabase(paths: CtxPaths): Database {
  ensureHome(paths);
  const db = openDb(paths.dbFile, { create: true });
  // Always safe, cheap, lock-free settings first.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  db.exec("PRAGMA foreign_keys = ON;");

  // Steady state (already WAL + migrated) is the overwhelmingly common case and
  // is completely lock-free. Only the rare first-time setup — enabling WAL and
  // running migrations — is serialized across processes with a file lock, because
  // the WAL switch needs a brief exclusive DB lock that concurrent openers would
  // otherwise collide on ("database is locked").
  if (isSetupComplete(db)) {
    db.exec("PRAGMA synchronous = NORMAL;");
    return db;
  }

  withFileLock(paths.dbFile + ".setup.lock", () => {
    enableWal(db);
    db.exec("PRAGMA synchronous = NORMAL;");
    runMigrations(db);
  });
  return db;
}

function isSetupComplete(db: Database): boolean {
  const jm = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  if (jm?.journal_mode?.toLowerCase() !== "wal") return false;
  try {
    const row = db.query<{ v: number | null }, []>(
      "SELECT MAX(version) AS v FROM schema_migrations",
    ).get();
    return (row?.v ?? 0) >= LATEST_VERSION;
  } catch {
    return false; // schema_migrations doesn't exist yet
  }
}

/** Open an in-memory database (used by tests that don't need persistence). */
export function openMemoryDatabase(): Database {
  const db = openDb(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  return db;
}

function enableWal(db: Database): void {
  const current = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  if (current?.journal_mode?.toLowerCase() === "wal") return;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      return;
    } catch (err) {
      if (!isBusy(err)) throw err;
      sleepSync(25 * (attempt + 1));
    }
  }
  // As a last resort, proceed on the default journal mode rather than crash.
}

/**
 * Apply pending migrations in a concurrency-safe way.
 *
 * Each migration runs inside its own `BEGIN IMMEDIATE` transaction, and the
 * already-applied version is re-read *inside* that transaction. If two processes
 * start migrating simultaneously, one wins the write lock and commits; the other
 * waits (busy_timeout), then re-reads, sees the migration applied, and skips it.
 * A migration therefore can never be applied twice, and the DB is never left
 * partially migrated (each migration is atomic).
 */
function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const ordered = [...migrations].sort((a, b) => a.version - b.version);

  for (const migration of ordered) {
    withWriteTx(db, () => {
      const applied = db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?",
        )
        .get(migration.version);
      if ((applied?.n ?? 0) > 0) return;
      db.exec(migration.sql);
      db.query(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, new Date().toISOString());
    });
  }
}
