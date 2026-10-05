import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";
import { contentTokens, subjectTokens } from "../src/core/preferences/analysis.ts";

/**
 * Lexical-prefilter SAFETY experiment (0.3.0 diagnostic, §14) — TEST ONLY, nothing
 * shipped. Gemini proposed a cheap token prefilter to shrink the relevance-scoring
 * candidate set. We measure whether such a prefilter is SAFE, i.e. whether it ever
 * drops a preference the real engine correctly returns.
 *
 * VERDICT (asserted below): a naive "share ≥1 subject token with the task" prefilter
 * is UNSAFE, because the engine scores a preference ABOVE threshold on a DOMAIN or
 * CATEGORY match alone (W_DOMAIN=0.5, W_CATEGORY=0.2, both ≥ the 0.25 threshold) with
 * ZERO shared subject tokens. The prefilter would silently drop such matches.
 */

/** The candidate predicate a naive lexical prefilter would use. */
function lexicalPrefilterKeeps(taskText: string, rule: string, category: string): boolean {
  const task = new Set(contentTokens(taskText));
  const terms = new Set([...subjectTokens(rule), ...subjectTokens(category)]);
  for (const tkn of terms) if (task.has(tkn)) return true;
  return false;
}

test("a DOMAIN-only relevance match is returned by the engine but DROPPED by a token prefilter (UNSAFE)", () => {
  const t = makeTestContext();
  try {
    // Clean store so conflict/cap/limit can't confound the demonstration. `testing`
    // is a NON-exclusive domain, so the sentinel is not dropped by conflict resolution.
    const SENT = "Prefer composition over inheritance.";
    t.ctx.preferences.remember({ rule: SENT, scope: "global", category: "general", domain: "testing" });

    // Task infers domain=testing (spec, coverage) but shares NO subject tokens with the rule.
    const task = "improve the spec coverage";
    const got = t.ctx.retrieval.retrieve({ cwd: "/x", task, track: false }).preferences.map((p) => p.rule);

    // The engine DOES return it (domain match alone, W_DOMAIN=0.5 ≥ 0.25 threshold).
    expect(got).toContain(SENT);
    // A naive lexical token prefilter would NOT keep it → a FALSE NEGATIVE → unsafe.
    expect(lexicalPrefilterKeeps(task, SENT, "general")).toBe(false);
  } finally {
    t.cleanup();
  }
});

test("prefilter safety is phrasing-dependent, not semantic (stemmer 'table' vs 'tables' mismatch)", () => {
  const t = makeTestContext();
  try {
    // Documents a second false-negative source: the light stemmer maps 'tables'→'tabl'
    // but 'table'→'table', so a direct lexical match can still miss.
    const { subjectTokens: subj } = require("../src/core/preferences/analysis.ts");
    expect(subj("tables").join(",")).not.toBe(subj("table").join(",")); // stems differ
  } finally {
    t.cleanup();
  }
});

test("cache-key oracle: a task-only memo key would serve a STALE result across languages", () => {
  const t = makeTestContext();
  try {
    t.ctx.preferences.remember({ rule: "Use strict TS null checks.", scope: "global", applicability: "conditional", condition: { language: "typescript" } });
    const task = "general work"; // identical task text …
    const ts = t.ctx.retrieval.retrieve({ cwd: "/x", task, languages: ["typescript"], track: false }).preferences.map((p) => p.rule);
    const py = t.ctx.retrieval.retrieve({ cwd: "/x", task, languages: ["python"], track: false }).preferences.map((p) => p.rule);
    // … yields DIFFERENT results by language, so any memo keyed on task alone is unsafe.
    expect(ts).toContain("Use strict TS null checks.");
    expect(py).not.toContain("Use strict TS null checks.");
  } finally {
    t.cleanup();
  }
});
