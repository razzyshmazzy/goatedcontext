import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { resolvePaths } from "../src/storage/paths.ts";

/**
 * WAL / busy_timeout / PRAGMA audit (0.3.0 diagnostic, CI-blocking guard).
 *
 * Documents and pins the actual on-disk connection settings so a future change that
 * silently weakens concurrency (e.g. dropping WAL or busy_timeout) fails loudly.
 * Values are READ, never changed.
 */

function openTempDb() {
  const home = mkdtempSync(join(tmpdir(), "ctx-wal-"));
  const db = openDatabase(resolvePaths({ CTX_HOME: home }));
  return { db, home, cleanup: () => { db.close(); rmSync(home, { recursive: true, force: true }); } };
}

test("a freshly-opened file database is WAL with the documented pragmas", () => {
  const { db, cleanup } = openTempDb();
  try {
    const jm = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    expect(jm?.journal_mode?.toLowerCase()).toBe("wal");

    const bt = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();
    expect(Number(bt?.timeout)).toBe(10000); // 10s — competing writers wait, not fail

    const sync = db.query<{ synchronous: number }, []>("PRAGMA synchronous").get();
    expect(Number(sync?.synchronous)).toBe(1); // NORMAL

    const fk = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
    expect(Number(fk?.foreign_keys)).toBe(1); // ON (cascades for repo/evidence)
  } finally {
    cleanup();
  }
});

test("reopening an already-set-up database keeps WAL + busy_timeout (no re-migration churn)", () => {
  const home = mkdtempSync(join(tmpdir(), "ctx-wal2-"));
  try {
    const paths = resolvePaths({ CTX_HOME: home });
    const a = openDatabase(paths);
    a.close();
    const b = openDatabase(paths);
    try {
      expect(b.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode?.toLowerCase()).toBe("wal");
      expect(Number(b.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout)).toBe(10000);
    } finally {
      b.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
