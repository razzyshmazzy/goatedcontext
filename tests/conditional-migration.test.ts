import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations } from "../src/storage/sqlite/migrations.ts";
import { openDb } from "../src/storage/sqlite/driver.ts";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { resolvePaths } from "../src/storage/paths.ts";

// Proves the 0.2.8 schema change is a real, non-destructive migration from the
// EXACT previous (0.2.7 / schema v4) layout — not just a fresh latest-schema DB.

test("migration v5 adds a null condition to a 0.2.7 (schema v4) database, preserving everything", () => {
  const home = mkdtempSync(join(tmpdir(), "ctx-mig5-"));
  try {
    const paths = resolvePaths({ CTX_HOME: home });

    // ---- Build a real pre-0.2.8 (schema v4) database by hand. ----
    const raw = openDb(paths.dbFile, { create: true });
    raw.exec("PRAGMA journal_mode = WAL;");
    raw.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
    );
    for (const m of migrations.filter((mm) => mm.version <= 4)) {
      raw.exec(m.sql);
      raw
        .query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(m.version, m.name, "2020-01-01T00:00:00.000Z");
    }

    // Repo record (repo association must survive).
    raw
      .query(
        "INSERT INTO repos (id, identity, name, remote_url, root_path, has_remote, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("repo1", "remote:github.com/acme/app", "app", "git@github.com:acme/app.git", "/tmp/app", 1, "t0", "t0");

    // Preferences spanning scopes, statuses, applicability, polarity, confidence, evidence.
    const insPref = raw.query(
      `INSERT INTO preferences
         (id, rule, normalized, category, domain, polarity, scope, repo_id, status,
          applicability, confidence, version, created_at, updated_at, last_used_at, dedup_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    // global relevant
    insPref.run("p1", "Prefer pnpm.", "prefer pnpm", "dependencies", "package-manager", "positive", "global", null, "approved", "relevant", 0.9, 3, "c1", "u1", "lu1", "global||pnpm|positive");
    // repo relevant (locked)
    insPref.run("p2", "Repo locked rule.", "repo locked rule", "general", null, "neutral", "repo", "repo1", "locked", "relevant", 1, 2, "c2", "u2", null, null);
    // global always
    insPref.run("p3", "Always respond in Italian.", "always respond in italian", "general", "response-language", "neutral", "global", null, "approved", "always", 1, 1, "c3", "u3", null, "global||italian respond|neutral");

    // Evidence + a history event + dedup indexes exercised.
    raw
      .query(
        "INSERT INTO evidence (id, preference_id, source, repo_id, evidence_text, agent_id, session_id, text_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run("e1", "p1", "explicit", null, "chosen for speed", "agentA", "sess1", "h1", "te1");
    raw
      .query(
        "INSERT INTO events (id, type, preference_id, repo_id, scope, summary, detail, agent_id, session_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run("ev1", "preference.remembered", "p1", null, "global", "Prefer pnpm.", null, null, null, "tev1");
    raw.close();

    // ---- Open with the full stack → applies migration v5. ----
    const db = openDatabase(paths);
    try {
      const v = db.query<{ v: number }, []>("SELECT MAX(version) AS v FROM schema_migrations").get();
      expect(v?.v).toBe(8); // latest: v5 condition, v6 dedup index, v7 signals, v8 exception context

      const cols = db
        .query<{ name: string }, []>("PRAGMA table_info(preferences)")
        .all()
        .map((r) => r.name);
      expect(cols).toContain("condition_json"); // new column exists

      const rows = db
        .query<
          {
            id: string;
            rule: string;
            status: string;
            applicability: string;
            condition_json: string | null;
            scope: string;
            repo_id: string | null;
            domain: string | null;
            polarity: string;
            confidence: number;
            dedup_key: string | null;
            created_at: string;
            last_used_at: string | null;
          },
          []
        >("SELECT * FROM preferences ORDER BY id")
        .all();

      expect(rows).toHaveLength(3); // all rows preserved
      for (const r of rows) expect(r.condition_json).toBeNull(); // additive: condition is null

      const p1 = rows.find((r) => r.id === "p1")!;
      expect(p1.applicability).toBe("relevant"); // applicability preserved
      expect(p1.domain).toBe("package-manager"); // domain preserved
      expect(p1.polarity).toBe("positive"); // polarity preserved
      expect(p1.confidence).toBe(0.9); // confidence preserved
      expect(p1.dedup_key).toBe("global||pnpm|positive"); // dedup key preserved
      expect(p1.created_at).toBe("c1"); // timestamps preserved
      expect(p1.last_used_at).toBe("lu1");

      const p2 = rows.find((r) => r.id === "p2")!;
      expect(p2.status).toBe("locked"); // status preserved
      expect(p2.scope).toBe("repo");
      expect(p2.repo_id).toBe("repo1"); // repo association preserved

      const p3 = rows.find((r) => r.id === "p3")!;
      expect(p3.applicability).toBe("always"); // always preserved exactly

      // Evidence preserved (text + provenance).
      const ev = db
        .query<{ n: number; agent_id: string | null }, []>(
          "SELECT COUNT(*) AS n, MAX(agent_id) AS agent_id FROM evidence",
        )
        .get();
      expect(ev?.n).toBe(1);
      expect(ev?.agent_id).toBe("agentA");

      // History preserved (append-only, survives migration).
      const events = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get();
      expect(events?.n).toBe(1);

      // Repo record preserved.
      const repo = db
        .query<{ identity: string; has_remote: number }, []>("SELECT identity, has_remote FROM repos")
        .get();
      expect(repo?.identity).toBe("remote:github.com/acme/app");
      expect(repo?.has_remote).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
