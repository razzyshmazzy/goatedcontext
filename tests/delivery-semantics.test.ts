import { test, expect } from "bun:test";
import { makeTestContext, makeGitRepo } from "./helpers.ts";
import type { DeliveryBudget } from "../src/core/retrieval/retrieval.ts";

/**
 * Delivery semantics (0.3.0 D1). The old hard caps (MAX_ALWAYS/MAX_CONDITIONAL = 20)
 * silently dropped valid matching rules and chose survivors by write-age. 0.3.0
 * delivers the FULL effective set (all `always` + all matched `conditional`), with
 * conflict/precedence resolution applied FIRST and any budget omission reported, not
 * silent. These tests are the permanent regression matrix (§9).
 */

const CWD = "/work";
const T = (languages?: string[]) => ({ cwd: CWD, task: "do the thing", languages, track: false as const });

// Each rule carries a DISTINCT subject token (`tag<i>`) so conflict resolution
// (which collapses same-subject rules) never masks the "all delivered" property —
// single-digit numbers tokenize away, so `tag${i}` is the reliable distinct subject.
function manyAlways(t: ReturnType<typeof makeTestContext>, n: number) {
  for (let i = 0; i < n; i++) {
    t.ctx.preferences.remember({ rule: `Always honor directive tag${i}.`, scope: "global", applicability: "always" });
  }
}
function manyConditional(t: ReturnType<typeof makeTestContext>, n: number) {
  for (let i = 0; i < n; i++) {
    t.ctx.preferences.remember({ rule: `Convention tag${i} for ts work.`, scope: "global", applicability: "conditional", condition: { language: "typescript" } });
  }
}

// ── all effective matching rules are delivered (no arbitrary count cap) ───────

test.each([21, 100])("%d matching ALWAYS rules are all delivered with no silent omission", (n) => {
  const t = makeTestContext();
  try {
    manyAlways(t, n);
    const r = t.ctx.retrieval.retrieve(T());
    expect(r.preferences.filter((p) => p.applicability === "always")).toHaveLength(n);
    expect(r.delivery.effective).toBe(n);
    expect(r.delivery.delivered).toBe(n);
    expect(r.delivery.omittedByBudget).toBe(0);
    expect(r.delivery.omittedByRelevanceLimit).toBe(0);
  } finally {
    t.cleanup();
  }
});

test.each([21, 100])("%d matching CONDITIONAL rules are all delivered with no silent omission", (n) => {
  const t = makeTestContext();
  try {
    manyConditional(t, n);
    const r = t.ctx.retrieval.retrieve(T(["typescript"]));
    expect(r.preferences.filter((p) => p.applicability === "conditional")).toHaveLength(n);
    expect(r.delivery.delivered).toBe(n);
    expect(r.delivery.omittedByBudget).toBe(0);
  } finally {
    t.cleanup();
  }
});

test("mixed always + conditional + relevant: all always & matched conditionals survive together", () => {
  const t = makeTestContext();
  try {
    manyAlways(t, 25);
    manyConditional(t, 25);
    for (let i = 0; i < 10; i++) {
      t.ctx.preferences.remember({ rule: `Prefer foreign keys policy ${i} for database schema design.`, category: "database", scope: "global", applicability: "relevant" });
    }
    const r = t.ctx.retrieval.retrieve({ cwd: CWD, task: "design the database schema", languages: ["typescript"], track: false });
    expect(r.preferences.filter((p) => p.applicability === "always")).toHaveLength(25);
    expect(r.preferences.filter((p) => p.applicability === "conditional")).toHaveLength(25);
    // Relevant rules keep the relevance top-K (≤15), and that is reported honestly.
    const rel = r.preferences.filter((p) => p.applicability === "relevant");
    expect(rel.length).toBeLessThanOrEqual(15);
    expect(r.delivery.omittedByBudget).toBe(0);
  } finally {
    t.cleanup();
  }
});

// ── conflicts / precedence among >20 rules ────────────────────────────────────

test("conflict resolution among >20 exclusive-domain always rules yields ONE effective winner", () => {
  const t = makeTestContext();
  try {
    // 25 competing package-manager always rules (an exclusive domain → one winner).
    for (let i = 0; i < 25; i++) {
      t.ctx.preferences.remember({ rule: `Always prefer package manager option ${i}.`, scope: "global", applicability: "always", domain: "package-manager" });
    }
    const r = t.ctx.retrieval.retrieve(T());
    expect(r.delivery.matched).toBe(25);
    expect(r.delivery.effective).toBe(1); // exclusive domain collapses to one
    expect(r.delivery.delivered).toBe(1);
    expect(r.overridden.length).toBe(24); // the rest are overridden, not budget-dropped
    expect(r.delivery.omittedByBudget).toBe(0);
  } finally {
    t.cleanup();
  }
});

test("repo precedence wins over >20 competing global rules on an exclusive domain", () => {
  const t = makeTestContext();
  const repo = makeGitRepo("https://github.com/acme/prec.git");
  try {
    const r0 = t.ctx.repos.resolve(repo.root)!;
    for (let i = 0; i < 25; i++) {
      t.ctx.preferences.remember({ rule: `Always prefer global pm option ${i}.`, scope: "global", applicability: "always", domain: "package-manager" });
    }
    t.ctx.preferences.remember({ rule: "Always use npm in this repo.", scope: "repo", repoId: r0.id, applicability: "always", domain: "package-manager" });
    const r = t.ctx.retrieval.retrieve({ cwd: repo.root, task: "install", track: false });
    const winners = r.preferences.filter((p) => p.domain === "package-manager");
    expect(winners).toHaveLength(1);
    expect(winners[0]!.rule).toContain("use npm"); // repo rule (rank 2) beats all 25 globals
    expect(winners[0]!.scope).toBe("repo");
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});

test("locked rules sort ahead of approved rules in the delivered always block (precedence, not age)", () => {
  const t = makeTestContext();
  try {
    // Insert approved rules FIRST (older), then a locked rule LAST (newest). If age
    // drove ordering the locked rule would trail; precedence must float it to front.
    for (let i = 0; i < 25; i++) {
      t.ctx.preferences.remember({ rule: `Always approved directive tag${i}.`, scope: "global", applicability: "always" });
    }
    const locked = t.ctx.preferences.remember({ rule: "Always locked top directive.", scope: "global", applicability: "always" });
    t.ctx.preferences.lock(locked.id, { expectedVersion: locked.version });

    const r = t.ctx.retrieval.retrieve(T());
    const always = r.preferences.filter((p) => p.applicability === "always");
    expect(always).toHaveLength(26); // all delivered
    expect(always[0]!.rule).toBe("Always locked top directive."); // locked floats to front
    expect(always[0]!.status).toBe("locked");
  } finally {
    t.cleanup();
  }
});

// ── determinism / no age-based accidental selection ──────────────────────────

test("delivery order is deterministic and every rule survives (no age-based dropping) across runs", () => {
  const t = makeTestContext();
  try {
    manyAlways(t, 40);
    const a = t.ctx.retrieval.retrieve(T());
    for (let i = 0; i < 25; i++) {
      const b = t.ctx.retrieval.retrieve(T());
      expect(b.preferences.map((p) => p.id)).toEqual(a.preferences.map((p) => p.id));
    }
    expect(a.preferences.filter((p) => p.applicability === "always")).toHaveLength(40);
  } finally {
    t.cleanup();
  }
});

// ── explicit delivery budget: deterministic, exact omitted set, observable ────

test("an explicit maxPreferences budget trims deterministically and reports the EXACT omitted set", () => {
  const t = makeTestContext();
  try {
    manyAlways(t, 10);
    // Full (unlimited) order is the oracle for what the budget must trim as a suffix.
    const full = t.ctx.retrieval.retrieve({ ...T(), explain: true });
    const fullIds = full.preferences.map((p) => p.id);
    expect(fullIds).toHaveLength(10);

    const budget: DeliveryBudget = { maxChars: null, maxPreferences: 4 };
    const trimmed = t.ctx.retrieval.retrieve({ ...T(), budget, explain: true });

    expect(trimmed.preferences.map((p) => p.id)).toEqual(fullIds.slice(0, 4)); // top-priority prefix kept
    expect(trimmed.delivery.delivered).toBe(4);
    expect(trimmed.delivery.omittedByBudget).toBe(6);
    expect(trimmed.delivery.omittedByBudgetIds).toEqual(fullIds.slice(4)); // exact least-important tail
    expect(trimmed.delivery.effective).toBe(10); // effective set is independent of the budget

    // Deterministic: a second identical call yields the identical trim.
    const again = t.ctx.retrieval.retrieve({ ...T(), budget, explain: true });
    expect(again.preferences.map((p) => p.id)).toEqual(trimmed.preferences.map((p) => p.id));
  } finally {
    t.cleanup();
  }
});

test("a maxChars budget keeps a top-priority prefix and always delivers at least one rule", () => {
  const t = makeTestContext();
  try {
    manyAlways(t, 10);
    const full = t.ctx.retrieval.retrieve({ ...T(), explain: true });
    // Budget big enough for only the first two rules' rule text.
    const twoChars = full.preferences.slice(0, 2).reduce((n, p) => n + Math.min(p.rule.length, 500), 0);
    const budget: DeliveryBudget = { maxChars: twoChars, maxPreferences: null };
    const trimmed = t.ctx.retrieval.retrieve({ ...T(), budget, explain: true });
    expect(trimmed.delivery.delivered).toBe(2);
    expect(trimmed.delivery.omittedByBudget).toBe(8);

    // A pathologically tiny budget still delivers one rule (never zero).
    const tiny = t.ctx.retrieval.retrieve({ ...T(), budget: { maxChars: 1, maxPreferences: null }, explain: true });
    expect(tiny.delivery.delivered).toBe(1);
  } finally {
    t.cleanup();
  }
});

test("the default (no budget) delivers everything — omittedByBudget is always 0", () => {
  const t = makeTestContext();
  try {
    manyAlways(t, 50);
    const r = t.ctx.retrieval.retrieve(T());
    expect(r.delivery.budget).toEqual({ maxChars: null, maxPreferences: null });
    expect(r.delivery.omittedByBudget).toBe(0);
    expect(r.delivery.delivered).toBe(50);
    // Without explain, the id list is not materialized (kept lean for the hot path).
    expect(r.delivery.omittedByBudgetIds).toBeUndefined();
  } finally {
    t.cleanup();
  }
});
