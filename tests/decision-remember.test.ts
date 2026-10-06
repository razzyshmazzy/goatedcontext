import { test, expect } from "bun:test";
import { makeTestContext, makeGitRepo } from "./helpers.ts";

/**
 * Decision-aware remember (0.3.5): one atomic write that persists an authoritative
 * preference AND, optionally, a non-authoritative cross-repo decision signal. §23/§24.
 */

// ── A. both written ─────────────────────────────────────────────────────────

test("A. decision-aware remember persists BOTH a preference and a signal", () => {
  const t = makeTestContext();
  try {
    const res = t.ctx.rememberWithDecision(
      { rule: "Use Supabase for the backend.", scope: "global", applicability: "always" },
      { domain: "backend", choice: "supabase", repoId: "rA" },
    );
    expect(res.preference.rule).toBe("Use Supabase for the backend.");
    expect(res.signalCreated).toBe(true);
    expect(res.signal?.domain).toBe("backend");
    expect(res.signal?.choice).toBe("supabase");
    expect(t.ctx.preferences.list()).toHaveLength(1);
    expect(t.ctx.signals.count()).toBe(1);
  } finally {
    t.cleanup();
  }
});

// ── B. signal dedup on a repeated identical decision ────────────────────────

test("B. a repeated identical decision does not spam a second signal row", () => {
  const t = makeTestContext();
  try {
    const input = { rule: "Use Supabase for the backend.", scope: "repo" as const, repoId: "r1" };
    // Seed a repo row so the repo-scoped preference FK resolves.
    // (repoId is a free id in signals; for the preference we use a real repo below.)
    const repo = makeGitRepo();
    const repoId = t.ctx.repos.resolve(repo.root)!.id;
    const decision = { domain: "backend", choice: "supabase", repoId };
    t.ctx.rememberWithDecision({ ...input, repoId }, decision);
    const second = t.ctx.rememberWithDecision({ ...input, repoId }, decision);
    // Same immediate context (same repo, same day) → the signal is deduped.
    expect(second.signalCreated).toBe(false);
    expect(t.ctx.signals.count()).toBe(1);
    repo.cleanup();
  } finally {
    t.cleanup();
  }
});

// ── C. signal failure rolls the preference back (atomic) ────────────────────

test("C. a failing signal write rolls back the preference (no half-written pair)", () => {
  const t = makeTestContext();
  try {
    expect(() =>
      t.ctx.rememberWithDecision(
        { rule: "Use Supabase for the backend.", scope: "global" },
        { domain: "backend", choice: "" }, // invalid choice → addInTx throws
      ),
    ).toThrow();
    // The whole transaction rolled back: NO preference and NO signal persisted.
    expect(t.ctx.preferences.list()).toHaveLength(0);
    expect(t.ctx.signals.count()).toBe(0);
  } finally {
    t.cleanup();
  }
});

// ── D. preference failure means no signal is attempted ──────────────────────

test("D. a failing preference write records no signal", () => {
  const t = makeTestContext();
  try {
    expect(() =>
      t.ctx.rememberWithDecision(
        { rule: "Use Supabase.", scope: "repo", repoId: null }, // repo scope needs a repoId → throws
        { domain: "backend", choice: "supabase" },
      ),
    ).toThrow();
    expect(t.ctx.preferences.list()).toHaveLength(0);
    expect(t.ctx.signals.count()).toBe(0);
  } finally {
    t.cleanup();
  }
});

// ── E. plain behavioral preference → preference only ────────────────────────

test("E. a behavioral preference with no decision records no signal", () => {
  const t = makeTestContext();
  try {
    const res = t.ctx.rememberWithDecision(
      { rule: "Never add dependencies without asking.", scope: "global", applicability: "always" },
      null,
    );
    expect(res.preference.id).toBeTruthy();
    expect(res.signal).toBeNull();
    expect(t.ctx.signals.count()).toBe(0);
  } finally {
    t.cleanup();
  }
});

// ── F. one-off architecture choice → signal only ────────────────────────────

test("F. a one-off decision records a signal and NO preference", () => {
  const t = makeTestContext();
  try {
    t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: "rProto" });
    expect(t.ctx.signals.count()).toBe(1);
    expect(t.ctx.preferences.list()).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

// ── G. exception decision carries preferred_choice/reason/constraint ────────

test("G. an exception decision records the reason, constraint, and preferred choice", () => {
  const t = makeTestContext();
  try {
    const res = t.ctx.rememberWithDecision(
      { rule: "Use Supabase here for video storage.", scope: "global" },
      {
        domain: "backend",
        choice: "supabase",
        repoId: "rX",
        preferredChoice: "firebase",
        reason: "video storage requirement does not fit preferred provider",
        constraint: "free-tier",
        exception: true,
      },
    );
    expect(res.signal?.isException).toBe(true);
    expect(res.signal?.preferredChoice).toBe("firebase");
    expect(res.signal?.constraintTag).toBe("free-tier");
    expect(res.signal?.reason).toContain("video storage");
  } finally {
    t.cleanup();
  }
});

// ── §24. CROSS-REPO LEARNING end-to-end (the key regression) ────────────────

test("cross-repo: two decision-aware remembers surface as evidence in a third repo", () => {
  const t = makeTestContext();
  const repoA = makeGitRepo("https://github.com/acme/app-a.git");
  const repoB = makeGitRepo("https://github.com/acme/app-b.git");
  const repoC = makeGitRepo("https://github.com/acme/app-c.git");
  try {
    for (const repo of [repoA, repoB]) {
      const repoId = t.ctx.repos.resolve(repo.root)!.id;
      // ONE decision-aware command per repo — repo preference + backend=supabase signal.
      const res = t.ctx.rememberWithDecision(
        { rule: "Use Supabase for the backend.", scope: "repo", repoId, applicability: "always" },
        { domain: "backend", choice: "supabase", repoId },
      );
      expect(res.signalCreated).toBe(true);
    }
    // No manual `ctx signal add` was ever run; evidence came from the remembers.
    // Repo C: a backend task surfaces the cross-repo Supabase evidence automatically.
    const result = t.ctx.retrieval.retrieve({ cwd: repoC.root, task: "set up the backend", track: false });
    const backend = result.observedPatterns?.find((p) => p.domain === "backend");
    expect(backend?.choices[0]?.label).toBe("supabase");
    expect(backend?.choices[0]?.distinctRepos).toBe(2);
    // Repo C has no preference of its own yet (evidence ≠ preference).
    const cId = t.ctx.repos.resolve(repoC.root)!.id;
    expect(t.ctx.preferences.list().some((p) => p.repoId === cId)).toBe(false);
  } finally {
    repoA.cleanup();
    repoB.cleanup();
    repoC.cleanup();
    t.cleanup();
  }
});
