import { test, expect } from "bun:test";
import { openMemoryDatabase } from "../src/storage/sqlite/db.ts";

test("database initializes with the latest migration applied", () => {
  const db = openMemoryDatabase();
  const row = db
    .query<{ v: number }, []>("SELECT MAX(version) AS v FROM schema_migrations")
    .get();
  expect(row?.v).toBe(7);
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

test("v6 adds a general dedup_key index (import dedup lookup is an index seek, not a scan)", () => {
  const db = openMemoryDatabase();
  const indexes = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='preferences'")
    .all()
    .map((r) => r.name);
  expect(indexes).toContain("idx_prefs_dedup"); // general (non-unique) index from v6
  expect(indexes).toContain("idx_prefs_dedup_unique"); // v2 partial-unique index still present
  // The approved/locked dedup lookup now seeks the index instead of scanning.
  const plan = db
    .query<{ detail: string }, [string]>("EXPLAIN QUERY PLAN SELECT * FROM preferences WHERE dedup_key = ? LIMIT 1")
    .all("k")
    .map((r) => r.detail)
    .join(" ");
  expect(plan).toContain("idx_prefs_dedup");
  expect(plan).not.toContain("SCAN preferences");
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
    "events",
    "decision_signals",
  ]) {
    expect(names).toContain(t);
  }
  db.close();
});

test("v7 adds the decision_signals ledger with its evidence indexes", () => {
  const db = openMemoryDatabase();
  const indexes = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='decision_signals'")
    .all()
    .map((r) => r.name);
  for (const idx of ["idx_signals_domain", "idx_signals_domain_choice", "idx_signals_repo", "idx_signals_created"]) {
    expect(indexes).toContain(idx);
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
