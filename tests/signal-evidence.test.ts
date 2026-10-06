import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";
import {
  selectRelevantSignalEvidence,
  DEFAULT_SIGNAL_EVIDENCE_BUDGET,
  type SignalEvidenceBudget,
} from "../src/core/signals/evidence.ts";
import {
  canonicalDomain,
  collectDomainsFromText,
  taskSignalDomains,
  expandCanonicalToRaw,
} from "../src/core/signals/domains.ts";
import { buildRuntimeContext } from "../src/core/retrieval/runtime-context.ts";
import { renderContextBlock } from "../src/core/render/context-block.ts";
import type { CtxContext } from "../src/core/context.ts";

/**
 * Automatic signal-evidence surfacing (0.3.4). Signals remain NON-authoritative
 * evidence; this exercises the §32 matrix end to end: relevant evidence surfaces at
 * a matching decision domain, stays out of unrelated tasks, preserves contradictions,
 * never becomes a preference, never leaks provenance, and stays fresh with no cache.
 */

// Retrieve with a deterministic tiny budget unless a test overrides it.
function patternsFor(ctx: CtxContext, task: string, opts: { cwd?: string; budget?: SignalEvidenceBudget } = {}) {
  const res = ctx.retrieval.retrieve({
    cwd: opts.cwd ?? "/not-a-repo",
    task,
    track: false,
    explain: true,
    signalEvidenceBudget: opts.budget,
  });
  return res;
}

// ── canonical domain layer ───────────────────────────────────────────────────

test("canonical domain aliases normalize classifier + signal vocabularies to one token", () => {
  expect(canonicalDomain("db")).toBe("database");
  expect(canonicalDomain("ui-framework")).toBe("frontend");
  expect(canonicalDomain("frontend-framework")).toBe("frontend");
  expect(canonicalDomain("server")).toBe("backend");
  expect(canonicalDomain("package-manager")).toBe("package-manager"); // identity
  expect(canonicalDomain("comment-language")).toBe("comment-language"); // unknown → identity
});

test("expandCanonicalToRaw returns every spelling that canonicalizes into the set", () => {
  const raw = expandCanonicalToRaw(["database"]);
  expect(raw).toContain("database");
  expect(raw).toContain("db");
  expect(raw).toContain("datastore");
  expect(raw).not.toContain("frontend");
});

test("task-domain matching covers the gaps the classifier misses", () => {
  // "backend" is not a classifier domain — a trigger supplies it.
  expect(collectDomainsFromText("set up the backend")).toContain("backend");
  // project bootstrapping maps to package-manager (where a PM choice is relevant).
  expect(collectDomainsFromText("initialize this project")).toContain("package-manager");
  // classifier-covered domains still work and are canonicalized.
  expect(collectDomainsFromText("add a CSS button component")).toContain("frontend");
  expect(collectDomainsFromText("write a database migration")).toContain("database");
});

// ── A. relevant evidence delivered ─────────────────────────────────────────────

test("A. 3 cross-repo backend=supabase signals + a backend task → Supabase evidence", () => {
  const t = makeTestContext();
  try {
    for (const r of ["rA", "rB", "rC"]) t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: r });
    const res = patternsFor(t.ctx, "set up the backend");
    const p = res.observedPatterns!.find((x) => x.domain === "backend")!;
    expect(p).toBeTruthy();
    expect(p.choices[0]!.label).toBe("supabase");
    expect(p.choices[0]!.distinctRepos).toBe(3);
    expect(p.contradictory).toBe(false);
    const block = renderContextBlock(res)!;
    expect(block).toContain("Observed developer decisions");
    expect(block.toLowerCase()).toContain("supabase");
    expect(block).toContain("3 repositories");
  } finally {
    t.cleanup();
  }
});

// ── B. unrelated task → no evidence ────────────────────────────────────────────

test("B. same backend signals + an unrelated CSS task → no backend evidence", () => {
  const t = makeTestContext();
  try {
    for (const r of ["rA", "rB", "rC"]) t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: r });
    const res = patternsFor(t.ctx, "tweak the CSS padding on the navbar");
    expect(res.observedPatterns!.find((x) => x.domain === "backend")).toBeUndefined();
    // The block, if any, must not mention the backend choice.
    expect((renderContextBlock(res) ?? "").toLowerCase()).not.toContain("supabase");
  } finally {
    t.cleanup();
  }
});

// ── C. contradiction preserved ─────────────────────────────────────────────────

test("C. Supabase in 3 repos + Firebase in 2 → both shown, no majority winner", () => {
  const t = makeTestContext();
  try {
    for (const r of ["rA", "rB", "rC"]) t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: r });
    for (const r of ["rD", "rE"]) t.ctx.signals.add({ domain: "backend", choice: "firebase", repoId: r });
    const res = patternsFor(t.ctx, "set up the backend");
    const p = res.observedPatterns!.find((x) => x.domain === "backend")!;
    expect(p.contradictory).toBe(true);
    const labels = p.choices.map((c) => c.label);
    expect(labels).toContain("supabase");
    expect(labels).toContain("firebase");
    const block = renderContextBlock(res)!;
    expect(block).toContain("no single default established");
  } finally {
    t.cleanup();
  }
});

// ── D. same-repo repetition is NOT broad cross-repo evidence ────────────────────

test("D. 20 React signals in ONE repo → represented as 1 repository, not a broad default", () => {
  const t = makeTestContext();
  try {
    // 20 genuinely-separate observations, all in the same repo (distinct sessions).
    for (let i = 0; i < 20; i++) {
      t.ctx.signals.add({ domain: "frontend", choice: "react", repoId: "rOnly", sessionId: `s${i}` });
    }
    const res = patternsFor(t.ctx, "add a React component to the frontend");
    const p = res.observedPatterns!.find((x) => x.domain === "frontend")!;
    expect(p.choices[0]!.distinctRepos).toBe(1);
    expect(p.choices[0]!.observations).toBe(20);
    const block = renderContextBlock(res)!;
    expect(block).toContain("1 repository");
    expect(block.toLowerCase()).not.toContain("strongly");
    expect(block.toLowerCase()).not.toContain("preferred");
  } finally {
    t.cleanup();
  }
});

// ── E. explicit preference + ordinary signals → preference authoritative ────────

test("E. explicit Firebase preference + ordinary Supabase signals → ordinary signals suppressed", () => {
  const t = makeTestContext();
  try {
    t.ctx.preferences.remember({ rule: "Prefer Firebase.", scope: "global", applicability: "always" });
    for (const r of ["rA", "rB"]) t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: r });
    const res = patternsFor(t.ctx, "set up the backend");
    const p = res.observedPatterns!.find((x) => x.domain === "backend");
    // Either no pattern, or a pattern whose ordinary choices are suppressed.
    if (p) {
      expect(p.hasExplicitPreference).toBe(true);
      expect(p.choices).toHaveLength(0);
    }
    const block = renderContextBlock(res)!;
    expect(block).toContain("Firebase"); // the authoritative preference remains
    // Ordinary (non-exception) Supabase signals are not presented as competing instruction.
    expect(block.toLowerCase()).not.toContain("supabase");
  } finally {
    t.cleanup();
  }
});

// ── F. explicit preference + EXCEPTION signals → both available ─────────────────

test("F. explicit Firebase preference + Supabase EXCEPTION signals → preference + exception shown", () => {
  const t = makeTestContext();
  try {
    t.ctx.preferences.remember({ rule: "Prefer Firebase.", scope: "global", applicability: "always" });
    for (const r of ["rA", "rB"]) {
      t.ctx.signals.add({
        domain: "backend",
        choice: "supabase",
        repoId: r,
        preferredChoice: "firebase",
        reason: "free-tier storage insufficient for video",
        constraint: "free-tier",
        exception: true,
      });
    }
    const res = patternsFor(t.ctx, "set up the backend");
    const p = res.observedPatterns!.find((x) => x.domain === "backend")!;
    expect(p.hasExplicitPreference).toBe(true);
    expect(p.choices).toHaveLength(0); // ordinary suppressed
    expect(p.exceptions).toHaveLength(1);
    expect(p.exceptions[0]!.label).toBe("supabase");
    const block = renderContextBlock(res)!;
    expect(block).toContain("Firebase");
    expect(block.toLowerCase()).toContain("supabase");
    expect(block).toContain("free-tier storage insufficient for video");
    expect(block).toContain("Historical reasons may be stale");
  } finally {
    t.cleanup();
  }
});

// ── G. explicit user instruction wins over historical evidence ──────────────────

test("G. user asks for npm while Bun evidence exists → no preference created; evidence is just evidence", () => {
  const t = makeTestContext();
  try {
    for (const r of ["rA", "rB", "rC", "rD", "rE"]) t.ctx.signals.add({ domain: "package-manager", choice: "bun", repoId: r });
    const res = patternsFor(t.ctx, "set this project up with npm");
    // ctx never creates a preference and never overrides the user: it only surfaces evidence.
    expect(t.ctx.preferences.list()).toHaveLength(0);
    const p = res.observedPatterns!.find((x) => x.domain === "package-manager");
    expect(p?.choices[0]?.label).toBe("bun");
    // The block is advisory evidence only — it never says "use bun".
    const block = renderContextBlock(res) ?? "";
    expect(block).not.toContain("use bun");
  } finally {
    t.cleanup();
  }
});

// ── L. no auto-promotion, ever ──────────────────────────────────────────────────

test("L. surfacing evidence never creates a preference or proposal row", () => {
  const t = makeTestContext();
  try {
    for (const r of ["rA", "rB", "rC", "rD"]) t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: r });
    for (let i = 0; i < 5; i++) {
      patternsFor(t.ctx, "set up the backend"); // repeated surfacing must not promote
    }
    expect(t.ctx.preferences.listCandidates({ repoId: null, includeProposed: true })).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

// ── N. evidence budget is deterministic ─────────────────────────────────────────

test("N. the output budget deterministically bounds domains surfaced", () => {
  const t = makeTestContext();
  try {
    for (const r of ["rA", "rB", "rC"]) t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: r });
    for (const r of ["rA", "rB", "rC"]) t.ctx.signals.add({ domain: "database", choice: "postgres", repoId: r });
    for (const r of ["rA", "rB", "rC"]) t.ctx.signals.add({ domain: "package-manager", choice: "bun", repoId: r });
    // A task touching all three domains, with a budget of one domain.
    const task = "initialize this backend project with a database";
    const budget: SignalEvidenceBudget = { ...DEFAULT_SIGNAL_EVIDENCE_BUDGET, maxDomains: 1 };
    const a = patternsFor(t.ctx, task, { budget }).observedPatterns!;
    const b = patternsFor(t.ctx, task, { budget }).observedPatterns!;
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // deterministic
    expect(a[0]!.domain).toBe(canonicalDomain(a[0]!.domain));
  } finally {
    t.cleanup();
  }
});

// ── O. privacy: no raw ids / paths / timestamps in the rendered block ───────────

test("O. the rendered block exposes no repo ids, session ids, paths, or timestamps", () => {
  const t = makeTestContext();
  try {
    t.ctx.signals.add({
      domain: "backend",
      choice: "supabase",
      repoId: "repo-abc123",
      sessionId: "session-xyz789",
      context: "/Users/secret/path",
    });
    t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: "repo-def456" });
    const res = patternsFor(t.ctx, "set up the backend");
    const block = renderContextBlock(res)!;
    expect(block).not.toContain("repo-abc123");
    expect(block).not.toContain("repo-def456");
    expect(block).not.toContain("session-xyz789");
    expect(block).not.toContain("/Users/secret/path");
    expect(block).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no ISO timestamps
  } finally {
    t.cleanup();
  }
});

// ── new-repo UX + current-repo distinction (§20/§21) ────────────────────────────

test("current-repo vs cross-repo observations are distinguished", () => {
  const rc = buildRuntimeContext({ cwd: "/x", repo: null, task: "set up the backend" });
  const evidence = [
    {
      domain: "backend",
      choices: [
        {
          choice: "supabase",
          label: "supabase",
          observations: 4,
          distinctRepos: 4,
          distinctSessions: 0,
          seenInCurrentRepo: true,
          firstSeen: "2026-01-01T00:00:00.000Z",
          lastSeen: "2026-02-01T00:00:00.000Z",
        },
      ],
      exceptions: [],
      contradictory: false,
    },
  ];
  const sel = selectRelevantSignalEvidence(rc, evidence, []);
  expect(sel.patterns[0]!.choices[0]!.seenInCurrentRepo).toBe(true);
  expect(sel.patterns[0]!.choices[0]!.otherRepos).toBe(3);
});

// ── freshness: no cache, immediate visibility and removal (§28) ─────────────────

test("M. evidence is fresh: a newly added signal appears, a cleared one disappears", () => {
  const t = makeTestContext();
  try {
    const before = patternsFor(t.ctx, "set up the backend").observedPatterns!;
    expect(before.find((p) => p.domain === "backend")).toBeUndefined();

    t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: "rA" });
    t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: "rB" });
    const after = patternsFor(t.ctx, "set up the backend").observedPatterns!;
    expect(after.find((p) => p.domain === "backend")?.choices[0]?.label).toBe("supabase");

    t.ctx.signals.clear("backend");
    const cleared = patternsFor(t.ctx, "set up the backend").observedPatterns!;
    expect(cleared.find((p) => p.domain === "backend")).toBeUndefined();
  } finally {
    t.cleanup();
  }
});

// ── empty-match: a task touching no signal domain surfaces nothing ──────────────

test("a task that matches no signal domain surfaces no evidence (and does no DB work)", () => {
  const rc = buildRuntimeContext({ cwd: "/x", repo: null, task: "say hello to the user" });
  expect(taskSignalDomains(rc).size).toBe(0);
  const sel = selectRelevantSignalEvidence(rc, [], []);
  expect(sel.patterns).toHaveLength(0);
  expect(sel.consideredDomains).toHaveLength(0);
});
