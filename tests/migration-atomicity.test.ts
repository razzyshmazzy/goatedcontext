import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/storage/sqlite/driver.ts";
import { openMemoryDatabase, runMigrations } from "../src/storage/sqlite/db.ts";
import { migrations, type Migration } from "../src/storage/sqlite/migrations.ts";
import { withWriteTx } from "../src/storage/sqlite/tx.ts";

/**
 * Migration atomicity (0.3.0 diagnostic, CI-blocking).
 *
 * Each migration runs in its own BEGIN IMMEDIATE tx; a failure must leave the schema
 * at the last good version with NO half-applied statements. We fault-inject via the
 * (test-exposed) `runMigrations(db, list)` with a throwing migration.
 */

function tempFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "ctx-mig-"));
  const db = openDb(join(dir, "m.db"), { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function versions(db: ReturnType<typeof openDb>): number[] {
  return db.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
}

test("all shipped migrations apply cleanly and reach the latest version", () => {
  const db = openMemoryDatabase(); // runs runMigrations(migrations) internally
  try {
    const latest = migrations.reduce((m, x) => Math.max(m, x.version), 0);
    expect(versions(db)).toEqual(migrations.map((m) => m.version).sort((a, b) => a - b));
    expect(Math.max(...versions(db))).toBe(latest);
  } finally {
    db.close();
  }
});

test("a migration that throws leaves the schema at the last GOOD version (no partial advance)", () => {
  const { db, cleanup } = tempFileDb();
  try {
    const list: Migration[] = [
      { version: 1, name: "good-one", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY);" },
      // v2 creates a table AND then runs invalid SQL: the whole migration must roll back.
      { version: 2, name: "bad-two", sql: "CREATE TABLE b (id INTEGER PRIMARY KEY); INSERT INTO does_not_exist VALUES (1);" },
      { version: 3, name: "good-three", sql: "CREATE TABLE c (id INTEGER PRIMARY KEY);" },
    ];
    expect(() => runMigrations(db, list)).toThrow();

    // v1 applied; v2 rolled back; v3 never reached.
    expect(versions(db)).toEqual([1]);
    // Intra-migration atomicity: table `b` from the failed v2 must NOT exist.
    const tbls = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    expect(tbls).toContain("a");
    expect(tbls).not.toContain("b");
    expect(tbls).not.toContain("c");
    // DB is still fully readable after the failed migration.
    expect(db.query("SELECT COUNT(*) AS n FROM a").get()).toBeTruthy();
  } finally {
    cleanup();
  }
});

test("re-running migrations after a fix is resumable and idempotent", () => {
  const { db, cleanup } = tempFileDb();
  try {
    const bad: Migration[] = [
      { version: 1, name: "good", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY);" },
      { version: 2, name: "bad", sql: "INSERT INTO missing VALUES (1);" },
    ];
    expect(() => runMigrations(db, bad)).toThrow();
    expect(versions(db)).toEqual([1]);

    // "Fixed" migration list: v2 now valid. Re-run resumes at v2 and does not re-apply v1.
    const fixed: Migration[] = [
      { version: 1, name: "good", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY);" },
      { version: 2, name: "fixed", sql: "CREATE TABLE b (id INTEGER PRIMARY KEY);" },
    ];
    runMigrations(db, fixed);
    expect(versions(db)).toEqual([1, 2]);
    // Idempotent: running again changes nothing.
    runMigrations(db, fixed);
    expect(versions(db)).toEqual([1, 2]);
  } finally {
    cleanup();
  }
});

test("withWriteTx rolls back ALL writes when the body throws (the migration primitive)", () => {
  const { db, cleanup } = tempFileDb();
  try {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);");
    db.query("INSERT INTO t VALUES (1, 'original')").run();
    expect(() =>
      withWriteTx(db, () => {
        db.query("INSERT INTO t VALUES (2, 'added')").run();
        db.query("UPDATE t SET v = 'mutated' WHERE id = 1").run();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // Both the insert and the update are rolled back.
    const rows = db.query<{ id: number; v: string }, []>("SELECT id, v FROM t ORDER BY id").all();
    expect(rows).toEqual([{ id: 1, v: "original" }]);
  } finally {
    cleanup();
  }
});
