import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { openDb } from "../src/storage/sqlite/driver.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { withWriteTx } from "../src/storage/sqlite/tx.ts";
import { newId } from "../src/utils/id.ts";

/**
 * Pre-migration BACKUP strategy experiment (§24) — EVALUATION ONLY, nothing shipped.
 * Evaluates `VACUUM INTO` (available in both bun:sqlite and node:sqlite as plain SQL)
 * for a pre-migration snapshot: correctness under WAL, restore integrity, and that a
 * concurrent reader is not blocked.
 */

function seed(db: ReturnType<typeof openDatabase>, n: number) {
  const ts = "2026-01-01T00:00:00.000Z";
  withWriteTx(db, () => {
    const ins = db.query(
      `INSERT INTO preferences (id, rule, normalized, category, domain, polarity, scope, repo_id, status, applicability, condition_json, confidence, version, created_at, updated_at, last_used_at, dedup_key)
       VALUES (?, ?, ?, 'general', NULL, 'neutral', 'global', NULL, 'approved', 'relevant', NULL, 1.0, 1, ?, ?, NULL, ?)`,
    );
    for (let i = 0; i < n; i++) ins.run(newId(), `rule ${i}`, `rule ${i}`, ts, ts, `global||rule ${i}|neutral|${i}`);
  });
}

test("VACUUM INTO produces a consistent standalone snapshot with identical row counts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-bak-"));
  try {
    const paths = resolvePaths({ CTX_HOME: dir });
    const db = openDatabase(paths);
    seed(db, 1_000);
    const srcCount = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM preferences").get()!.n;

    const backup = join(dir, "backup.db").replace(/\\/g, "/"); // forward slashes for the SQL literal
    db.exec(`VACUUM INTO '${backup}'`);
    expect(existsSync(backup)).toBe(true);

    // Original is untouched and still usable.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM preferences").get()!.n).toBe(srcCount);
    db.close();

    // The snapshot opens standalone and has the SAME data (restore integrity).
    const restored = openDb(backup, { readonly: true });
    try {
      expect(restored.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM preferences").get()!.n).toBe(srcCount);
      const integrity = restored.query<Record<string, string>, []>("PRAGMA integrity_check").all();
      expect(Object.values(integrity[0]!)[0]).toBe("ok");
    } finally {
      restored.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VACUUM INTO while another connection holds an open read snapshot still succeeds", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-bak2-"));
  try {
    const paths = resolvePaths({ CTX_HOME: dir });
    const writer = openDatabase(paths);
    seed(writer, 500);

    // A second connection with an open read transaction (simulated concurrent reader).
    const reader = openDatabase(paths);
    reader.exec("BEGIN DEFERRED");
    reader.query("SELECT COUNT(*) FROM preferences").get();

    const backup = join(dir, "snap.db").replace(/\\/g, "/");
    // WAL lets the backup proceed alongside the reader.
    writer.exec(`VACUUM INTO '${backup}'`);
    expect(statSync(backup).size).toBeGreaterThan(0);

    reader.exec("COMMIT");
    reader.close();
    writer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
