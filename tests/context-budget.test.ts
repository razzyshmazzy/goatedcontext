import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestContext } from "./helpers.ts";
import { buildContextEnvelope } from "../src/core/agents/envelope.ts";

// Phase 6 (0.4.0): context-budget INSTRUMENTATION — measure delivered context so
// accumulated-preference growth is observable. No consolidation, no dedup, no silent
// drops: when an effective preference is omitted, the counts say so.

function diag(ctx: ReturnType<typeof makeTestContext>["ctx"], opts: Parameters<typeof ctx.retrieval.retrieve>[0]) {
  const result = ctx.retrieval.retrieve({ ...opts, explain: true, track: false });
  return buildContextEnvelope(result, {}).meta.diagnostics;
}

test("accounting identity: candidate >= effective >= delivered; overflow == any omission", () => {
  const t = makeTestContext();
  try {
    t.ctx.preferences.remember({ rule: "Always write tests.", scope: "global", applicability: "always" });
    t.ctx.preferences.remember({ rule: "Never add deps without asking.", scope: "global", applicability: "always" });
    const d = diag(t.ctx, { cwd: t.dir, task: "do work" });
    expect(d.candidate).toBeGreaterThanOrEqual(d.effective);
    expect(d.effective).toBeGreaterThanOrEqual(d.delivered);
    // effective - delivered is exactly the omissions (relevance + budget).
    expect(d.effective - d.delivered).toBe(d.omittedByRelevance + d.omittedByBudget);
    expect(d.overflow).toBe(d.omittedByRelevance > 0 || d.omittedByBudget > 0);
    // No budget → everything effective is delivered.
    expect(d.delivered).toBe(d.effective);
    expect(d.overflow).toBe(false);
    expect(d.renderedChars).toBeGreaterThan(0);
    expect(d.approxTokens).toBe(Math.ceil(d.renderedChars / 4));
  } finally {
    t.cleanup();
  }
});

test("authoritative overflow is SURFACED, never silently dropped (§31)", () => {
  const t = makeTestContext();
  try {
    // Three independent always rules; a budget of 1 forces two to be omitted-by-budget.
    t.ctx.preferences.remember({ rule: "Always write tests.", scope: "global", applicability: "always" });
    t.ctx.preferences.remember({ rule: "Never add deps without asking.", scope: "global", applicability: "always" });
    t.ctx.preferences.remember({ rule: "Prefer small pull requests.", scope: "global", applicability: "always" });
    const d = diag(t.ctx, { cwd: t.dir, task: "do work", budget: { maxChars: null, maxPreferences: 1 } });
    expect(d.effective).toBe(3); // ctx still KNOWS there are 3 effective rules
    expect(d.delivered).toBe(1);
    expect(d.omittedByBudget).toBe(2); // the two dropped rules are COUNTED, not hidden
    expect(d.overflow).toBe(true);
  } finally {
    t.cleanup();
  }
});

test(
  "ctx context-budget --json reports the diagnostics",
  () => {
    const h = mkdtempSync(join(tmpdir(), "ctx-cb-"));
    const env = { ...process.env, CTX_HOME: h, CTX_SECRET_BACKEND: "file" } as Record<string, string>;
    const BUN = process.execPath;
    const INDEX = join(import.meta.dir, "..", "src", "index.ts");
    try {
      execFileSync(BUN, ["run", INDEX, "remember", "--always", "Always write tests."], { env });
      const out = execFileSync(BUN, ["run", INDEX, "context-budget", "--task", "work", "--json"], {
        env,
        encoding: "utf8",
      });
      const parsed = JSON.parse(out);
      for (const k of [
        "candidate", "effective", "delivered", "authoritative", "observedPatterns",
        "renderedChars", "approxTokens", "omittedByRelevance", "omittedByBudget", "overflow",
      ]) {
        expect(parsed.diagnostics).toHaveProperty(k);
      }
      expect(parsed.diagnostics.authoritative).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  },
  60_000,
);
