import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestContext } from "./helpers.ts";
import { inferApplicability } from "../src/core/preferences/analysis.ts";
import { migrations } from "../src/storage/sqlite/migrations.ts";
import { openDb } from "../src/storage/sqlite/driver.ts";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { exportData, importData } from "../src/core/transfer/transfer.ts";

function rules(result: { preferences: { rule: string }[] }): string[] {
  return result.preferences.map((p) => p.rule);
}

// ---- inference --------------------------------------------------------------

test("inference: obvious universal directives → always", () => {
  const always = [
    "Always respond in Italian.",
    "always respond in italian",
    "Never use emojis.",
    "Every time you finish a coding task, run the tests.",
    "For all tasks, prefer concise explanations.",
    "For every task, keep explanations concise.",
    "Regardless of task, keep responses short.",
    "Whenever you respond, be concise.",
  ];
  for (const r of always) expect(inferApplicability(r)).toBe("always");
});

test("inference: soft/embedded phrasing stays relevant (no naive substring match)", () => {
  const relevant = [
    "Prefer PostgreSQL for relational data.",
    "Prefer simple architecture.",
    "Use npm in this repository.",
    "Avoid Redis unless distributed caching is necessary.",
    "Prefer functions that never throw.",
    "Use always-on caching when supported.",
    "The never-ending stream should be buffered.",
    "Prefer an always-visible toolbar.",
    "Usually prefer composition over inheritance.",
    "Generally, keep modules small.",
    "You should write tests.",
  ];
  for (const r of relevant) expect(inferApplicability(r)).toBe("relevant");
});

// ---- explicit applicability + inference on write ----------------------------

test("explicit --applicability wins over inference; inference fills the gap", () => {
  const t = makeTestContext();
  // Inference would say "relevant", but explicit always overrides.
  const forced = t.ctx.preferences.remember({
    rule: "Prefer concise explanations.",
    scope: "global",
    applicability: "always",
  });
  expect(forced.applicability).toBe("always");

  // No explicit value → inferred as always from the leading directive.
  const inferred = t.ctx.preferences.remember({
    rule: "Always respond in Italian.",
    scope: "global",
  });
  expect(inferred.applicability).toBe("always");

  // No explicit value, ordinary rule → relevant.
  const rel = t.ctx.preferences.remember({
    rule: "Prefer PostgreSQL for relational data.",
    scope: "global",
  });
  expect(rel.applicability).toBe("relevant");
  t.cleanup();
});

test("explicit relevant forces a leading-directive rule to stay relevant", () => {
  const t = makeTestContext();
  const p = t.ctx.preferences.remember({
    rule: "Always respond in Italian.",
    scope: "global",
    applicability: "relevant",
  });
  expect(p.applicability).toBe("relevant");
  // As a relevant rule it is NOT injected for an unrelated task.
  const result = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task: "hi", track: false });
  expect(rules(result)).not.toContain(p.rule);
  t.cleanup();
});

// ---- retrieval behavior -----------------------------------------------------

test("always-on preference is injected for an unrelated prompt; relevant is not", () => {
  const t = makeTestContext();
  const italian = t.ctx.preferences.remember({
    rule: "always respond in italian",
    category: "general",
    scope: "global",
  });
  const db = t.ctx.preferences.remember({
    rule: "Prefer relational constraints for important integrity rules.",
    category: "database",
    scope: "global",
  });
  const result = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task: "hi", track: false });
  const got = rules(result);
  expect(got).toContain(italian.rule); // always rule injected
  expect(got).not.toContain(db.rule); // relevant DB rule not injected for "hi"
  t.cleanup();
});

test("mixed: a database task returns BOTH the always rule and the relevant DB rule", () => {
  const t = makeTestContext();
  const italian = t.ctx.preferences.remember({ rule: "always respond in italian", scope: "global" });
  const db = t.ctx.preferences.remember({
    rule: "Prefer relational constraints for important integrity rules.",
    category: "database",
    scope: "global",
  });
  const result = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    task: "design a database schema with constraints",
    track: false,
  });
  const got = rules(result);
  expect(got).toContain(italian.rule);
  expect(got).toContain(db.rule);
  t.cleanup();
});

test("unrelated task with no always rules returns zero preferences (unchanged)", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({
    rule: "Prefer relational constraints for important integrity rules.",
    category: "database",
    scope: "global",
  });
  const result = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task: "hi", track: false });
  expect(result.preferences).toHaveLength(0);
  t.cleanup();
});

test("always-on rules bypass relevance but NOT status: rejected always never appears", () => {
  const t = makeTestContext();
  const p = t.ctx.preferences.remember({ rule: "Always respond in Italian.", scope: "global" });
  t.ctx.preferences.reject(p.id, { expectedVersion: p.version });
  const result = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task: "hi", track: false });
  expect(rules(result)).not.toContain(p.rule);
  t.cleanup();
});

test("proposed always-on is excluded by default, included with includeProposed", () => {
  const t = makeTestContext();
  const { preference } = t.ctx.preferences.propose({
    rule: "Always respond in Italian.",
    scope: "global",
    evidence: "user asked repeatedly",
  });
  expect(preference.applicability).toBe("always");

  const def = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task: "hi", track: false });
  expect(rules(def)).not.toContain(preference.rule); // proposed excluded by default

  const withProposed = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    task: "hi",
    track: false,
    includeProposed: true,
  });
  expect(rules(withProposed)).toContain(preference.rule);
  t.cleanup();
});

test("retrieved preferences carry applicability in the result", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({ rule: "Always respond in Italian.", scope: "global" });
  const result = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task: "hi", track: false });
  expect(result.preferences[0]?.applicability).toBe("always");
  t.cleanup();
});

// ---- precedence / conflict --------------------------------------------------

test("repo always-on overrides a conflicting global always-on (precedence)", () => {
  const t = makeTestContext();
  const repo = t.ctx.repos.resolve(process.cwd());
  expect(repo).not.toBeNull();
  const globalIt = t.ctx.preferences.remember({
    rule: "Always respond in Italian.",
    scope: "global",
  });
  const repoEn = t.ctx.preferences.remember({
    rule: "Always respond in English.",
    scope: "repo",
    repoId: repo!.id,
  });
  // Both are the exclusive response-language decision.
  expect(globalIt.domain).toBe("response-language");
  expect(repoEn.domain).toBe("response-language");

  const result = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task: "hi", track: false });
  const got = rules(result);
  expect(got).toContain(repoEn.rule); // repo wins
  expect(got).not.toContain(globalIt.rule); // global suppressed
  expect(result.overridden.map((o) => o.id)).toContain(globalIt.id);
  t.cleanup();
});

test("an always rule and a relevant rule can still conflict on the same exclusive domain", () => {
  const t = makeTestContext();
  const repo = t.ctx.repos.resolve(process.cwd());
  // Relevant repo rule vs always global rule, same exclusive package-manager domain.
  const relRepo = t.ctx.preferences.remember({
    rule: "This repository must use npm.",
    category: "dependencies",
    scope: "repo",
    repoId: repo!.id,
    applicability: "relevant",
  });
  const alwaysGlobal = t.ctx.preferences.remember({
    rule: "Always use pnpm.",
    category: "dependencies",
    scope: "global",
    applicability: "always",
  });
  expect(relRepo.domain).toBe("package-manager");
  expect(alwaysGlobal.domain).toBe("package-manager");
  // A package-manager task surfaces both pools; the repo (higher precedence) wins.
  const result = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    task: "which package manager should we use to install a dependency",
    track: false,
  });
  const got = rules(result);
  expect(got).toContain(relRepo.rule);
  expect(got).not.toContain(alwaysGlobal.rule);
  t.cleanup();
});

// ---- export / import --------------------------------------------------------

test("export/import round-trips applicability and defaults old bundles to relevant", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({ rule: "Always respond in Italian.", scope: "global" });
  t.ctx.preferences.remember({
    rule: "Prefer relational constraints for integrity.",
    category: "database",
    scope: "global",
    applicability: "relevant",
  });
  const bundle = exportData(t.ctx);
  const byRule = Object.fromEntries(bundle.preferences.map((p) => [p.rule, p.applicability]));
  expect(byRule["Always respond in Italian."]).toBe("always");
  expect(byRule["Prefer relational constraints for integrity."]).toBe("relevant");

  // Import into a fresh context round-trips applicability.
  const t2 = makeTestContext();
  importData(t2.ctx, bundle);
  const imported = Object.fromEntries(t2.ctx.preferences.list().map((p) => [p.rule, p.applicability]));
  expect(imported["Always respond in Italian."]).toBe("always");
  expect(imported["Prefer relational constraints for integrity."]).toBe("relevant");

  // An OLD bundle (no applicability field) imports as relevant.
  const t3 = makeTestContext();
  const legacy = {
    schema: "ctx-export",
    version: 1,
    exportedAt: "2020-01-01T00:00:00.000Z",
    repos: [],
    preferences: [
      {
        rule: "Legacy rule without applicability.",
        category: "general",
        domain: null,
        polarity: "neutral",
        scope: "global",
        status: "approved",
        confidence: 1,
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
        repoIdentity: null,
        evidence: [],
      },
    ],
  };
  importData(t3.ctx, legacy);
  const legacyImported = t3.ctx.preferences.list().find((p) => p.rule === "Legacy rule without applicability.");
  expect(legacyImported?.applicability).toBe("relevant");

  t.cleanup();
  t2.cleanup();
  t3.cleanup();
});

// ---- history ----------------------------------------------------------------

test("remembered/proposed events carry applicability in their detail", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({ rule: "Always respond in Italian.", scope: "global" });
  t.ctx.preferences.propose({
    rule: "Prefer relational constraints for integrity.",
    category: "database",
    scope: "global",
    evidence: "seen",
  });
  const events = t.ctx.events.list({ limit: 10 });
  const remembered = events.find((e) => e.type === "preference.remembered");
  const proposed = events.find((e) => e.type === "preference.proposed");
  expect(remembered?.detail?.applicability).toBe("always");
  expect(proposed?.detail?.applicability).toBe("relevant");
  t.cleanup();
});

// ---- validation -------------------------------------------------------------

test("an unknown applicability value is rejected with no write", () => {
  const t = makeTestContext();
  expect(() =>
    t.ctx.preferences.remember({
      rule: "Some rule.",
      scope: "global",
      applicability: "banana" as never,
    }),
  ).toThrow();
  expect(t.ctx.preferences.list()).toHaveLength(0); // nothing persisted
  t.cleanup();
});

// ---- safety cap (performance guard) ----------------------------------------

test("always-on rules are capped deterministically and never starved by relevant top-K", () => {
  const t = makeTestContext();
  // 100 always rules + 50 relevant rules.
  for (let i = 0; i < 100; i++) {
    t.ctx.preferences.remember({ rule: `Always apply universal directive ${i}.`, scope: "global" });
  }
  for (let i = 0; i < 50; i++) {
    t.ctx.preferences.remember({
      rule: `Prefer database policy ${i} for schema design.`,
      category: "database",
      scope: "global",
      applicability: "relevant",
    });
  }
  const a = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task: "hi", track: false });
  const alwaysReturned = a.preferences.filter((p) => p.applicability === "always");
  // Capped at MAX_ALWAYS (20), never zero — the relevance top-K cannot starve them.
  expect(alwaysReturned).toHaveLength(20);

  // Deterministic: the same prompt yields the same set (no random selection).
  const b = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task: "hi", track: false });
  expect(b.preferences.map((p) => p.id)).toEqual(a.preferences.map((p) => p.id));
  t.cleanup();
});

// ---- migration --------------------------------------------------------------

test("migration v4 adds applicability=relevant to a pre-0.2.4 database, preserving data", () => {
  const home = mkdtempSync(join(tmpdir(), "ctx-mig4-"));
  try {
    const paths = resolvePaths({ CTX_HOME: home });

    // Build a real pre-0.2.4 (schema v3) database by hand.
    const raw = openDb(paths.dbFile, { create: true });
    raw.exec("PRAGMA journal_mode = WAL;");
    raw.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
    );
    for (const m of migrations.filter((mm) => mm.version <= 3)) {
      raw.exec(m.sql);
      raw
        .query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(m.version, m.name, "2020-01-01T00:00:00.000Z");
    }
    raw
      .query(
        "INSERT INTO repos (id, identity, name, remote_url, root_path, has_remote, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("repo1", "remote:github.com/acme/app", "app", null, "/tmp/app", 0, "t", "t");
    const insPref = raw.query(
      `INSERT INTO preferences
         (id, rule, normalized, category, domain, polarity, scope, repo_id, status,
          confidence, version, created_at, updated_at, last_used_at, dedup_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    insPref.run("p1", "Use pnpm.", "use pnpm", "dependencies", "package-manager", "positive", "global", null, "approved", 1, 1, "t", "t", null, "global||pnpm|positive");
    insPref.run("p2", "Repo locked rule.", "repo locked rule", "general", null, "neutral", "repo", "repo1", "locked", 1, 1, "t", "t", null, null);
    insPref.run("p3", "Rejected rule.", "rejected rule", "general", null, "neutral", "global", null, "rejected", 1, 1, "t", "t", null, null);
    raw
      .query(
        "INSERT INTO evidence (id, preference_id, source, repo_id, evidence_text, agent_id, session_id, text_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run("e1", "p1", "explicit", null, "seen", null, null, "h1", "t");
    raw.close();

    // Open with the full stack → applies every pending migration (v4, v5, …).
    const db = openDatabase(paths);
    try {
      const v = db.query<{ v: number }, []>("SELECT MAX(version) AS v FROM schema_migrations").get();
      expect(v?.v).toBe(5);

      const rows = db
        .query<
          { id: string; status: string; applicability: string; condition_json: string | null; repo_id: string | null },
          []
        >("SELECT id, status, applicability, condition_json, repo_id FROM preferences ORDER BY id")
        .all();
      expect(rows).toHaveLength(3); // row count preserved
      for (const r of rows) expect(r.applicability).toBe("relevant"); // v4 default applied
      for (const r of rows) expect(r.condition_json).toBeNull(); // v5 adds a null condition column
      expect(rows.map((r) => r.status)).toEqual(["approved", "locked", "rejected"]); // statuses preserved
      expect(rows.find((r) => r.id === "p2")?.repo_id).toBe("repo1"); // repo link preserved

      const ev = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM evidence").get();
      expect(ev?.n).toBe(1); // evidence preserved
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
