import { test, expect } from "bun:test";
import { makeTestContext, makeGitRepo } from "./helpers.ts";

/**
 * Exception evidence on decision signals (0.3.3). An exception captures WHY a choice
 * departed from the usual preference; it is evidence ONLY and never mutates a
 * preference. Aggregation keeps ordinary defaults and exceptions apart and preserves
 * each exception's reason/constraint — reasons matter more than raw counts.
 */

// ── schema: additive nullable columns ────────────────────────────────────────

test("v8 adds exception columns; an ordinary signal leaves them null/0", () => {
  const t = makeTestContext();
  try {
    const cols = t.ctx.db
      .query<{ name: string }, []>("PRAGMA table_info(decision_signals)")
      .all()
      .map((r) => r.name);
    for (const c of ["preferred_choice", "reason", "constraint_tag", "is_exception"]) {
      expect(cols).toContain(c);
    }
    const s = t.ctx.signals.add({ domain: "backend", choice: "firebase" }).signal;
    expect(s.isException).toBe(false);
    expect(s.preferredChoice).toBeNull();
    expect(s.reason).toBeNull();
    expect(s.constraintTag).toBeNull();
  } finally {
    t.cleanup();
  }
});

// ── exception recording + conservative normalization ─────────────────────────

test("an exception preserves the reason verbatim and normalizes choice-like fields", () => {
  const t = makeTestContext();
  try {
    const s = t.ctx.signals.add({
      domain: "Backend",
      choice: "Supabase",
      preferredChoice: "Firebase",
      reason: "Free-tier storage INSUFFICIENT for the video workload", // must be preserved verbatim
      constraint: "Free Tier",
      exception: true,
    }).signal;
    expect(s.isException).toBe(true);
    expect(s.choice).toBe("supabase"); // normalized
    expect(s.preferredChoice).toBe("firebase"); // normalized
    expect(s.constraintTag).toBe("free-tier"); // normalized (kebab)
    expect(s.reason).toBe("Free-tier storage INSUFFICIENT for the video workload"); // NOT normalized
  } finally {
    t.cleanup();
  }
});

// ── §8/§21: an exception signal does NOT mutate any preference ────────────────

test("recording an exception never weakens, deletes, or creates a preference", () => {
  const t = makeTestContext();
  try {
    const pref = t.ctx.preferences.remember({ rule: "Prefer Firebase.", scope: "global", category: "infrastructure" });
    t.ctx.signals.add({ domain: "backend", choice: "supabase", preferredChoice: "firebase", reason: "free-tier storage", constraint: "free-tier", exception: true });
    const after = t.ctx.preferences.getById(pref.id)!;
    expect(after.status).toBe("approved"); // untouched
    expect(after.rule).toBe("Prefer Firebase.");
    expect(t.ctx.preferences.list()).toHaveLength(1); // no new/removed preference
  } finally {
    t.cleanup();
  }
});

// ── §10/§11: ordinary vs exception kept apart; reasons/counts preserved ───────

test("aggregation separates the ordinary default from exceptions (reasons, not just counts)", () => {
  const t = makeTestContext();
  try {
    // Firebase is the ordinary default in two repos; Supabase an exception in two more.
    t.ctx.signals.add({ domain: "backend", choice: "firebase", repoId: "rA" });
    t.ctx.signals.add({ domain: "backend", choice: "firebase", repoId: "rB" });
    for (const r of ["rC", "rD"]) {
      t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: r, preferredChoice: "firebase", reason: "free-tier storage insufficient", constraint: "free-tier", exception: true });
    }
    const [ev] = t.ctx.signals.aggregate("backend");
    // Ordinary default is Firebase; it is NOT conflated with the exception.
    expect(ev!.choices).toHaveLength(1);
    expect(ev!.choices[0]!.choice).toBe("firebase");
    expect(ev!.choices[0]!.distinctRepos).toBe(2);
    expect(ev!.contradictory).toBe(false); // one ordinary default
    // The exception is tracked separately, with its reason + constraint + preferred choice.
    expect(ev!.exceptions).toHaveLength(1);
    const ex = ev!.exceptions[0]!;
    expect(ex.choice).toBe("supabase");
    expect(ex.preferredChoice).toBe("firebase");
    expect(ex.distinctRepos).toBe(2);
    expect(ex.reasons).toEqual(["free-tier storage insufficient"]);
    expect(ex.constraints).toEqual(["free-tier"]);
    // No preference was created by any of this.
    expect(t.ctx.preferences.list()).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

// ── §25: contradictory exceptions keep distinct reasons, no false alternative ─

test("contradictory exceptions preserve distinct reasons and do not collapse", () => {
  const t = makeTestContext();
  try {
    t.ctx.signals.add({ domain: "backend", choice: "firebase", repoId: "rC" }); // ordinary default
    t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: "rA", preferredChoice: "firebase", reason: "storage capacity", constraint: "storage", exception: true });
    t.ctx.signals.add({ domain: "backend", choice: "aws", repoId: "rB", preferredChoice: "firebase", reason: "compliance", constraint: "compliance", exception: true });
    const [ev] = t.ctx.signals.aggregate("backend");
    expect(ev!.choices[0]!.choice).toBe("firebase"); // default unchanged
    // Two DISTINCT exception choices with distinct reasons — not merged into one "winner".
    const exChoices = ev!.exceptions.map((e) => e.choice).sort();
    expect(exChoices).toEqual(["aws", "supabase"]);
    const reasons = ev!.exceptions.flatMap((e) => e.reasons).sort();
    expect(reasons).toEqual(["compliance", "storage capacity"]);
  } finally {
    t.cleanup();
  }
});

// ── §27: cross-agent — provenance, not ownership (shared evidence) ────────────

test("cross-agent: an exception recorded by one agent is visible to another (shared store)", () => {
  const t = makeTestContext();
  try {
    // "Claude" records the global preference; "Codex" records an exception signal.
    t.ctx.preferences.remember({ rule: "Prefer Firebase.", scope: "global", category: "infrastructure", agentId: "claude" });
    t.ctx.signals.add({ domain: "backend", choice: "supabase", preferredChoice: "firebase", reason: "free-tier storage", constraint: "free-tier", exception: true, agentId: "codex" });
    // Later reasoning (any agent) sees the same evidence — agent_id is provenance only.
    const [ev] = t.ctx.signals.aggregate("backend");
    expect(ev!.exceptions[0]!.choice).toBe("supabase");
    const raw = t.ctx.signals.list({ domain: "backend" });
    expect(raw[0]!.agentId).toBe("codex"); // provenance preserved, not ownership
    expect(t.ctx.preferences.list()).toHaveLength(1); // no duplicate preference
  } finally {
    t.cleanup();
  }
});

// ── §23 (dedup still correct): exception vs ordinary same context are distinct ─

test("an exception and an ordinary choice in the same context are distinct evidence", () => {
  const t = makeTestContext();
  const repo = makeGitRepo("https://github.com/acme/dedup.git");
  try {
    const id = t.ctx.repos.resolve(repo.root)!.id;
    const a = t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: id });
    const b = t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: id, preferredChoice: "firebase", reason: "storage", constraint: "free-tier", exception: true });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true); // exception-ness makes it separate evidence
    // A repeat of the exact ordinary one in the same day dedupes.
    expect(t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: id }).created).toBe(false);
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});
