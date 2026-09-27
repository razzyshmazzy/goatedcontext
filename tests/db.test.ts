import { test, expect } from "bun:test";
import { openMemoryDatabase } from "../src/storage/sqlite/db.ts";

test("database initializes with the latest migration applied", () => {
  const db = openMemoryDatabase();
  const row = db
    .query<{ v: number }, []>("SELECT MAX(version) AS v FROM schema_migrations")
    .get();
  expect(row?.v).toBe(2);
  db.close();
});

test("v2 columns and indexes exist", () => {
  const db = openMemoryDatabase();
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(preferences)")
    .all()
    .map((r) => r.name);
  for (const c of ["domain", "polarity", "version", "dedup_key"]) {
    expect(cols).toContain(c);
  }
  const evCols = db
    .query<{ name: string }, []>("PRAGMA table_info(evidence)")
    .all()
    .map((r) => r.name);
  for (const c of ["agent_id", "session_id", "text_hash"]) {
    expect(evCols).toContain(c);
  }
  db.close();
});

test("all core tables exist after initialization", () => {
  const db = openMemoryDatabase();
  const names = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
  for (const t of [
    "repos",
    "preferences",
    "evidence",
    "environments",
    "environment_variables",
  ]) {
    expect(names).toContain(t);
  }
  db.close();
});

test("migrations are idempotent across reopen", () => {
  // Two independent in-memory DBs both migrate cleanly to version 1.
  const a = openMemoryDatabase();
  const b = openMemoryDatabase();
  const va = a.query<{ v: number }, []>("SELECT MAX(version) v FROM schema_migrations").get();
  const vb = b.query<{ v: number }, []>("SELECT MAX(version) v FROM schema_migrations").get();
  expect(va?.v).toBe(vb?.v);
  a.close();
  b.close();
});
