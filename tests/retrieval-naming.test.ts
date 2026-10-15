/**
 * Naming/identity retrieval bridge (retrieval pass, spec §11–§12).
 *
 * How the user wants to be addressed ("Call me Greg") stores with no domain and shares
 * almost no vocabulary with how it is asked for ("what do you call me?"), so lexical
 * scoring alone missed it. `isNamingIntent` bridges task↔rule by INTENT. These tests
 * are fast and in-process (no spawn) so they run in the main `bun test`; the black-box
 * corpus (benchmarks/autonomous-pull/retrieval-corpus.ts) covers the broader picture.
 *
 * NOTE: this proves retrieval of a naming memory generically — it never special-cases
 * the literal name "Greg" (spec §12).
 */
import { test, expect, describe } from "bun:test";
import { makeTestContext } from "./helpers.ts";

const NAMING_QUERIES = [
  "what do you call me",
  "how should you address me",
  "the user's preferred name / how they want to be addressed",
  "how should I address the user",
  "what is my name",
];

// Naming-adjacent but NOT identity requests: these must NOT drag the naming memory in.
const PRECISION_TASKS = [
  "rename this file to config.ts",
  "name the new helper function",
  "add a call button to the form",
  "explain TCP slow start",
  "what is the capital of France?",
];

function retrieveRules(task: string, seedRules: string[]): string[] {
  const t = makeTestContext();
  try {
    for (const rule of seedRules) t.ctx.preferences.remember({ rule, scope: "global" });
    const res = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task, track: false });
    return res.preferences.map((p) => p.rule.toLowerCase());
  } finally {
    t.cleanup();
  }
}

describe("naming/identity retrieval bridge", () => {
  test("a naming query retrieves the stored naming memory across phrasings", () => {
    for (const q of NAMING_QUERIES) {
      const rules = retrieveRules(q, ["Call me Greg.", "Use Vitest for unit tests."]);
      expect(rules.some((r) => r.includes("greg"))).toBe(true);
    }
  });

  test("it bridges other naming phrasings too (never special-cases a literal name)", () => {
    for (const rule of ["Address the user as Dr. Chen.", "Refer to me as Sam.", "I go by Alex."]) {
      const rules = retrieveRules("what should you call me?", [rule]);
      expect(rules.length).toBeGreaterThan(0);
    }
  });

  test("naming-adjacent / unrelated tasks do NOT surface the naming memory (precision)", () => {
    for (const task of PRECISION_TASKS) {
      const rules = retrieveRules(task, ["Call me Greg."]);
      expect(rules.some((r) => r.includes("greg"))).toBe(false);
    }
  });

  test("a naming query does not drag in unrelated non-naming preferences", () => {
    const rules = retrieveRules("what do you call me", [
      "Call me Greg.",
      "Use PostgreSQL for relational persistence.",
      "Use Vitest for unit tests.",
    ]);
    // Only the naming memory should come back for a pure naming question.
    expect(rules.some((r) => r.includes("greg"))).toBe(true);
    expect(rules.some((r) => r.includes("postgres") || r.includes("vitest"))).toBe(false);
  });

  test("the bridge is additive only: a naming query with no naming memory returns nothing", () => {
    const rules = retrieveRules("what do you call me", ["Use Vitest for unit tests."]);
    expect(rules.length).toBe(0);
  });
});
