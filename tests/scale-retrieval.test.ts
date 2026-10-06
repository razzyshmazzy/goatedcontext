import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";
import { generateDataset, bulkSeed } from "./bench/fixtures.ts";
import { resolveConflicts } from "../src/core/retrieval/retrieval.ts";
import { isExclusiveDomain } from "../src/core/preferences/analysis.ts";

/**
 * Retrieval CORRECTNESS under scale (0.3.0 diagnostic, CI-blocking).
 *
 * A sentinel is planted in a field of noise and we assert it is returned iff the
 * context matches. Sizes are CI-friendly (≤10k); heavier timing work is in
 * scripts/bench. The last two tests are permanent 0.3.0 D1 regressions: the old
 * always/conditional caps (20 each) silently dropped matching rules; now EVERY
 * effective matching rule is delivered.
 */

const NOISE = 10_000;

test("conditional language gate: matches TS context, not Python/none (needle in noise, below cap)", () => {
  const t = makeTestContext();
  try {
    // Kept small enough that fewer than MAX_CONDITIONAL (20) conditionals match, so
    // this test isolates the GATE, not the cap (see the cap finding test below).
    bulkSeed(t.ctx.db, generateDataset(150, { seed: 11, repoCount: 5 }));

    const SENTINEL = "SENTINEL-LANG use strict null checks here.";
    t.ctx.preferences.remember({
      rule: SENTINEL,
      category: "architecture",
      scope: "global",
      applicability: "conditional",
      condition: { language: "typescript" },
    });

    const ts = t.ctx.retrieval.retrieve({ cwd: "/x", task: "general work", languages: ["typescript"], track: false });
    const py = t.ctx.retrieval.retrieve({ cwd: "/x", task: "general work", languages: ["python"], track: false });
    const none = t.ctx.retrieval.retrieve({ cwd: "/x", task: "general work", track: false });

    // Guard: this test only isolates the gate when matches stay under the cap.
    expect(ts.preferences.filter((p) => p.applicability === "conditional").length).toBeLessThanOrEqual(20);
    expect(ts.preferences.map((p) => p.rule)).toContain(SENTINEL); // D. conditional match
    expect(py.preferences.map((p) => p.rule)).not.toContain(SENTINEL); // non-match
    expect(none.preferences.map((p) => p.rule)).not.toContain(SENTINEL); // missing context never matches
  } finally {
    t.cleanup();
  }
});

test("rejected/proposed sentinels are NEVER delivered (status filtering under scale)", () => {
  const t = makeTestContext();
  try {
    bulkSeed(t.ctx.db, generateDataset(5_000, { seed: 3 }));

    const REJECTED = t.ctx.preferences.remember({ rule: "SENTINEL-REJECTED always use tabs.", scope: "global", applicability: "always" });
    t.ctx.preferences.reject(REJECTED.id, { expectedVersion: REJECTED.version });
    t.ctx.preferences.propose({ rule: "SENTINEL-PROPOSED always use spaces.", scope: "global", applicability: "always", evidence: "observed once" });

    const got = t.ctx.retrieval.retrieve({ cwd: "/x", task: "formatting", track: false }).preferences.map((p) => p.rule);
    expect(got.some((r) => r.includes("SENTINEL-REJECTED"))).toBe(false);
    expect(got.some((r) => r.includes("SENTINEL-PROPOSED"))).toBe(false);

    const withProposed = t.ctx.retrieval
      .retrieve({ cwd: "/x", task: "formatting", includeProposed: true, track: false })
      .preferences.map((p) => p.rule);
    expect(withProposed.some((r) => r.includes("SENTINEL-REJECTED"))).toBe(false); // rejected still excluded
  } finally {
    t.cleanup();
  }
});

test("conflict resolution scales: exactly ONE winner per exclusive domain across 10k", () => {
  const t = makeTestContext();
  try {
    bulkSeed(t.ctx.db, generateDataset(NOISE, { seed: 9, repoCount: 30 }));
    // Operate on the raw active candidate set the engine would see globally.
    const active = t.ctx.preferences.list().filter((p) => p.status === "approved" || p.status === "locked");
    const { winners } = resolveConflicts(active);
    // Every exclusive domain present must have at most ONE winner.
    const byDomain = new Map<string, number>();
    for (const w of winners) {
      if (isExclusiveDomain(w.domain)) byDomain.set(w.domain!, (byDomain.get(w.domain!) ?? 0) + 1);
    }
    for (const [, n] of byDomain) expect(n).toBe(1);
    expect(byDomain.size).toBeGreaterThan(0); // the dataset plants a package-manager conflict
  } finally {
    t.cleanup();
  }
});

// 100 sequential retrievals over a 3,000-preference field: ~43ms/call here, so ~4.3s
// locally and comfortably over the 5000ms default on slower macOS/Windows CI runners.
// The loop is a deliberate determinism oracle (byte-stable across runs), not a timing
// test, so it gets a generous explicit timeout rather than fewer iterations.
test("repeated identical retrieval is byte-stable across 100 runs (no hidden state drift / cache oracle baseline)", () => {
  const t = makeTestContext();
  try {
    bulkSeed(t.ctx.db, generateDataset(3_000, { seed: 21, repoCount: 8 }));
    const first = JSON.stringify(t.ctx.retrieval.retrieve({ cwd: "/x", task: "database schema design", languages: ["typescript"], track: false }));
    for (let i = 0; i < 100; i++) {
      const again = JSON.stringify(t.ctx.retrieval.retrieve({ cwd: "/x", task: "database schema design", languages: ["typescript"], track: false }));
      expect(again).toBe(first);
    }
  } finally {
    t.cleanup();
  }
}, 15_000);

// ── 0.3.0 D1 regression: EVERY effective matching rule is delivered (no cap) ──

test("D1: >20 matching global ALWAYS rules are ALL delivered (old MAX_ALWAYS cap removed)", () => {
  const t = makeTestContext();
  try {
    // 40 distinct global always rules, same precedence (global/approved). All match
    // every prompt by definition; all 40 must now be delivered, with no silent drop.
    for (let i = 0; i < 40; i++) {
      t.ctx.preferences.remember({ rule: `Always honor global rule tag${i} distinctly.`, scope: "global", applicability: "always" });
    }
    const got = t.ctx.retrieval.retrieve({ cwd: "/x", task: "anything", track: false });
    const always = got.preferences.filter((p) => p.applicability === "always");
    expect(always.length).toBe(40); // all delivered — nothing silently dropped
    expect(got.delivery.omittedByBudget).toBe(0);
    expect(got.delivery.omittedByRelevanceLimit).toBe(0);
  } finally {
    t.cleanup();
  }
});

test("D1: >20 matching CONDITIONAL rules are ALL delivered (old MAX_CONDITIONAL cap removed)", () => {
  const t = makeTestContext();
  try {
    for (let i = 0; i < 40; i++) {
      t.ctx.preferences.remember({
        rule: `Use convention tag${i} for typescript work.`,
        scope: "global",
        applicability: "conditional",
        condition: { language: "typescript" },
      });
    }
    const got = t.ctx.retrieval.retrieve({ cwd: "/x", task: "work", languages: ["typescript"], track: false });
    const cond = got.preferences.filter((p) => p.applicability === "conditional");
    expect(cond.length).toBe(40); // all matching conditionals delivered
    expect(got.delivery.omittedByBudget).toBe(0);
  } finally {
    t.cleanup();
  }
});
