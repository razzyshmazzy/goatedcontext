import { test, expect } from "bun:test";
import { makeTestContext, makeGitRepo } from "./helpers.ts";
import { normalizeDomain, normalizeChoice } from "../src/core/signals/service.ts";
import { exportData } from "../src/core/transfer/transfer.ts";

/**
 * Signals ledger (0.3.2). Signals are NON-authoritative evidence, strictly separate
 * from preferences: cross-repo/session evidence is preserved, same-immediate-context
 * repeats are de-duped, contradictions are kept, there is NO count-based promotion,
 * and nothing in the ledger ever becomes or injects a preference.
 */

// ── normalization ─────────────────────────────────────────────────────────────

test("domain/choice normalization is a simple canonical string (no embeddings)", () => {
  expect(normalizeDomain("Package Manager")).toBe("package-manager");
  expect(normalizeDomain("  Frontend_Framework ")).toBe("frontend-framework");
  expect(normalizeChoice("Supabase")).toBe("supabase");
  expect(normalizeChoice("  POSTGRES  ")).toBe("postgres");
});

// ── add / list / filter / json ─────────────────────────────────────────────────

test("add, list, domain filter, and raw shape", () => {
  const t = makeTestContext();
  try {
    t.ctx.signals.add({ domain: "backend", choice: "supabase" });
    t.ctx.signals.add({ domain: "package-manager", choice: "bun" });
    expect(t.ctx.signals.list()).toHaveLength(2);
    const backend = t.ctx.signals.list({ domain: "Backend" }); // filter is normalized
    expect(backend).toHaveLength(1);
    expect(backend[0]!.choice).toBe("supabase");
    expect(backend[0]!.choiceRaw).toBe("supabase");
  } finally {
    t.cleanup();
  }
});

// ── same-immediate-context dedup vs genuinely separate evidence ──────────────────

test("same context (repo+session+day) de-dupes; different repo/session is preserved", () => {
  const t = makeTestContext();
  try {
    const a = t.ctx.signals.add({ domain: "backend", choice: "Supabase", repoId: "rA", sessionId: "s1" });
    const b = t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: "rA", sessionId: "s1" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false); // deduped — same immediate context
    expect(t.ctx.signals.count()).toBe(1);

    // A different repo and a different session are each separate evidence.
    expect(t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: "rB", sessionId: "s1" }).created).toBe(true);
    expect(t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: "rA", sessionId: "s2" }).created).toBe(true);
    expect(t.ctx.signals.count()).toBe(3);
  } finally {
    t.cleanup();
  }
});

// ── cross-repo aggregation + contradiction (§22/§23) ─────────────────────────────

test("the same choice across distinct repos aggregates as distinctRepos (breadth, not raw count)", () => {
  const t = makeTestContext();
  try {
    for (const r of ["rA", "rB", "rC"]) t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: r });
    const [evidence] = t.ctx.signals.aggregate("backend");
    expect(evidence!.choices).toHaveLength(1);
    expect(evidence!.choices[0]!.choice).toBe("supabase");
    expect(evidence!.choices[0]!.observations).toBe(3);
    expect(evidence!.choices[0]!.distinctRepos).toBe(3);
    expect(evidence!.contradictory).toBe(false);

    // IMPORTANT: hitting "3 repos" does NOT create a preference. No auto-promotion.
    expect(t.ctx.preferences.list()).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("contradictory choices are both preserved; the minority is never hidden", () => {
  const t = makeTestContext();
  try {
    for (const r of ["rA", "rB", "rC"]) t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: r });
    t.ctx.signals.add({ domain: "backend", choice: "firebase", repoId: "rD" });
    const [evidence] = t.ctx.signals.aggregate("backend");
    expect(evidence!.contradictory).toBe(true);
    const choices = evidence!.choices.map((c) => c.choice);
    expect(choices).toContain("supabase");
    expect(choices).toContain("firebase"); // minority kept
    // Strongest evidence (more distinct repos) is listed first.
    expect(evidence!.choices[0]!.choice).toBe("supabase");
  } finally {
    t.cleanup();
  }
});

test("distinctSessions is tracked when a session id is supplied", () => {
  const t = makeTestContext();
  try {
    t.ctx.signals.add({ domain: "test-framework", choice: "vitest", repoId: "rA", sessionId: "s1" });
    t.ctx.signals.add({ domain: "test-framework", choice: "vitest", repoId: "rB", sessionId: "s2" });
    const [evidence] = t.ctx.signals.aggregate("test-framework");
    expect(evidence!.choices[0]!.distinctSessions).toBe(2);
  } finally {
    t.cleanup();
  }
});

// ── deletion / cleanup ───────────────────────────────────────────────────────────

test("forget removes one signal; clear removes all (or one domain)", () => {
  const t = makeTestContext();
  try {
    const a = t.ctx.signals.add({ domain: "backend", choice: "supabase" }).signal;
    t.ctx.signals.add({ domain: "database", choice: "postgres" });
    expect(t.ctx.signals.forget(a.id)).toBe(true);
    expect(t.ctx.signals.count()).toBe(1);
    t.ctx.signals.add({ domain: "database", choice: "postgres", repoId: "rX" });
    expect(t.ctx.signals.clear("database")).toBe(2);
    expect(t.ctx.signals.count()).toBe(0);
  } finally {
    t.cleanup();
  }
});

// ── signals NEVER become / inject preferences ───────────────────────────────────

test("raw signals never create or inject a preference (evidence, not instructions)", () => {
  const t = makeTestContext();
  try {
    for (const r of ["rA", "rB", "rC", "rD", "rE"]) t.ctx.signals.add({ domain: "package-manager", choice: "bun", repoId: r });
    // No preference exists, and retrieval returns nothing derived from signals.
    expect(t.ctx.preferences.list()).toHaveLength(0);
    const res = t.ctx.retrieval.retrieve({ cwd: "/x", task: "install a package with the package manager", track: false });
    expect(res.preferences).toHaveLength(0);
    expect(JSON.stringify(res)).not.toContain("bun");
  } finally {
    t.cleanup();
  }
});

// ── privacy: only compact decision evidence, nothing else ────────────────────────

test("the ledger stores ONLY compact decision fields — no transcript/code/secret columns", () => {
  const t = makeTestContext();
  try {
    const cols = t.ctx.db
      .query<{ name: string }, []>("PRAGMA table_info(decision_signals)")
      .all()
      .map((r) => r.name)
      .sort();
    expect(cols).toEqual(
      ["agent_id", "choice", "choice_raw", "context", "created_at", "domain", "id", "repo_id", "session_id"].sort(),
    );
  } finally {
    t.cleanup();
  }
});

// ── export deliberately EXCLUDES signals (§26) ───────────────────────────────────

test("export excludes signals entirely (they are local, non-portable evidence)", () => {
  const t = makeTestContext();
  try {
    t.ctx.preferences.remember({ rule: "Prefer Postgres for relational data.", scope: "global", category: "database" });
    t.ctx.signals.add({ domain: "backend", choice: "supabase-secret-marker" });
    const bundle = exportData(t.ctx);
    const json = JSON.stringify(bundle);
    expect(json).not.toContain("supabase-secret-marker"); // no signal choice leaked
    expect(json).not.toContain("decision_signals");
    expect("signals" in bundle).toBe(false);
    // The authoritative preference is still exported.
    expect(bundle.preferences.some((p) => p.rule.includes("Postgres"))).toBe(true);
  } finally {
    t.cleanup();
  }
});

// ── cross-repo scenario via the real repo resolver (§23) ─────────────────────────

test("§23: backend=supabase across 3 real repos → distinctRepos 3, zero preferences; repo D disagrees", () => {
  const t = makeTestContext();
  const a = makeGitRepo("https://github.com/acme/repoA.git");
  const b = makeGitRepo("https://github.com/acme/repoB.git");
  const c = makeGitRepo("https://github.com/acme/repoC.git");
  const d = makeGitRepo("https://github.com/acme/repoD.git");
  try {
    for (const repo of [a, b, c]) {
      t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: t.ctx.repos.resolve(repo.root)!.id });
    }
    let [ev] = t.ctx.signals.aggregate("backend");
    expect(ev!.choices[0]!.distinctRepos).toBe(3);
    expect(ev!.contradictory).toBe(false);
    expect(t.ctx.preferences.list()).toHaveLength(0); // never auto-promoted at "3"

    t.ctx.signals.add({ domain: "backend", choice: "firebase", repoId: t.ctx.repos.resolve(d.root)!.id });
    [ev] = t.ctx.signals.aggregate("backend");
    expect(ev!.contradictory).toBe(true);
    expect(ev!.choices.map((x) => x.choice).sort()).toEqual(["firebase", "supabase"]);
  } finally {
    a.cleanup(); b.cleanup(); c.cleanup(); d.cleanup();
    t.cleanup();
  }
});
