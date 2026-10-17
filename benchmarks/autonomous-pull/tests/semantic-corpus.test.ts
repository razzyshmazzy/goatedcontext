/**
 * Retrieval-ENGINE corpus regression (engine pass, spec §9–§11).
 *
 * Schema assertions are pure (always run). The black-box recall/precision run cold-spawns
 * `ctx` dozens of times, so it is GATED behind CTXBENCH_CORPUS=1 like the other corpora.
 * It guards the engine improvements this pass made: morphology (deployment↔deploy),
 * domain-abstracted proper-noun recall (BullMQ from "add a job queue"), and the
 * explanatory-intent gate that keeps conceptual questions from injecting a preference —
 * at the ≥95% recall / ≥95% precision bar the pass targeted.
 */
import { test, expect, describe } from "bun:test";
import {
  SEM_CASES,
  SEM_SEEDS,
  setupSemanticSandbox,
  runSemantic,
  summarizeSemantic,
} from "../semantic-corpus.ts";

const ENABLED = process.env.CTXBENCH_CORPUS === "1";
const BIG_TIMEOUT = 180_000;

describe("semantic engine corpus — schema (spec §9)", () => {
  test("covers every class and is balanced between positives and negatives", () => {
    for (const k of ["morphology", "semantic", "proper-noun", "adjacent-neg", "unrelated-neg"]) {
      expect(SEM_CASES.some((c) => c.klass === k)).toBe(true);
    }
    const pos = SEM_CASES.filter((c) => c.expect).length;
    const neg = SEM_CASES.filter((c) => !c.expect).length;
    expect(pos).toBeGreaterThanOrEqual(12);
    expect(neg).toBeGreaterThanOrEqual(10);
    // every positive points at a real seed; every adjacent-neg forbids a real seed
    const ids = new Set(SEM_SEEDS.map((s) => s.id));
    for (const c of SEM_CASES) {
      if (c.expect) expect(ids.has(c.expect)).toBe(true);
      if (c.forbid) expect(ids.has(c.forbid)).toBe(true);
    }
    // the store carries same-domain distractors (≥3 infrastructure rules) and both scopes
    expect(SEM_SEEDS.some((s) => s.scope === "repo")).toBe(true);
  });
});

(ENABLED ? describe : describe.skip)("semantic engine corpus — recall & precision (black-box)", () => {
  test(
    "≥95% positive recall AND ≥95% negative precision, with deterministic top-1",
    () => {
      const sb = setupSemanticSandbox();
      try {
        const results = runSemantic(sb);
        const s = summarizeSemantic(results);

        const posRecall =
          (s.morphologyRecall.num + s.semanticRecall.num + s.properNounRecall.num) /
          (s.morphologyRecall.den + s.semanticRecall.den + s.properNounRecall.den);
        const negPrec =
          (s.adjacentPrecision.num + s.unrelatedPrecision.num) /
          (s.adjacentPrecision.den + s.unrelatedPrecision.den);

        expect(posRecall).toBeGreaterThanOrEqual(0.95);
        expect(negPrec).toBeGreaterThanOrEqual(0.95);
        // no hard false positives on forbidden/unrelated seeds
        expect(s.falsePositiveRate.num).toBe(0);
        // ranking is deterministic (the rule-text tie-break) → top-1 stays high
        expect(s.top1.num / s.top1.den).toBeGreaterThanOrEqual(0.9);
      } finally {
        sb.cleanup();
      }
    },
    BIG_TIMEOUT,
  );
});
