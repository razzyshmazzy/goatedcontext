import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/storage/sqlite/driver.ts";

// Regression tests for the openDb() open-boundary hardening: it must guarantee its
// own preconditions so a caller can never trip SQLite's opaque "unable to open
// database file" through a missing parent directory or a missing read-only file.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "ctx-driver-"));
}

test("write open creates missing parent directories", () => {
  const base = scratch();
  try {
    const dbPath = join(base, "a", "b", "c", "ctx.db"); // none of a/b/c exist yet
    const db = openDb(dbPath, { create: true });
    db.exec("CREATE TABLE t(x INTEGER)");
    db.query("INSERT INTO t(x) VALUES (?)").run(1);
    const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM t").get();
    db.close();
    expect(existsSync(dbPath)).toBe(true);
    expect(row?.n).toBe(1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("read-only open of a missing file throws an explicit, path-bearing error", () => {
  const base = scratch();
  try {
    const missing = join(base, "does-not-exist.db");
    let message = "";
    expect(() => {
      try {
        openDb(missing, { readonly: true });
      } catch (e) {
        message = (e as Error).message;
        throw e;
      }
    }).toThrow();
    // Explicit and diagnosable — not SQLite's opaque "unable to open database file".
    expect(message).toContain("read-only");
    expect(message).toContain(missing);
    expect(message).not.toContain("unable to open database file");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("read-only open of an existing database works", () => {
  const base = scratch();
  try {
    const dbPath = join(base, "ctx.db");
    const rw = openDb(dbPath, { create: true });
    rw.exec("CREATE TABLE t(x INTEGER)");
    rw.query("INSERT INTO t(x) VALUES (?)").run(42);
    rw.close();

    const ro = openDb(dbPath, { readonly: true });
    const row = ro.query<{ x: number }, []>("SELECT x FROM t").get();
    ro.close();
    expect(row?.x).toBe(42);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test(":memory: opens without touching the filesystem", () => {
  const db = openDb(":memory:");
  db.exec("CREATE TABLE t(x INTEGER)");
  db.query("INSERT INTO t(x) VALUES (?)").run(7);
  const row = db.query<{ x: number }, []>("SELECT x FROM t").get();
  db.close();
  expect(row?.x).toBe(7);
});
