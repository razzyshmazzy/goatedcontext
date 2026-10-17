import { test, expect } from "bun:test";
import { GOLD_MEMORIES } from "../gold-specs.ts";
import { TRAJECTORIES } from "../scenarios.ts";
import { parseActivationSpec, unknownVocabTerms } from "../../../src/core/overseer/activation.ts";
import { runOverseerBaseline, runPromptOnly, seedCtx } from "../harness.ts";
import { lateEmergingRecall, pct, scoreBaseline, type BaselineRun } from "../score.ts";

test("every gold activation spec uses only the closed vocabulary and parses", () => {
  for (const m of GOLD_MEMORIES) {
    expect(() => parseActivationSpec(m.spec)).not.toThrow();
    expect(unknownVocabTerms(m.spec)).toEqual([]);
  }
});

test("gold memory ids are unique", () => {
  const ids = GOLD_MEMORIES.map((m) => m.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("every trajectory expectation references a real gold memory", () => {
  const ids = new Set(GOLD_MEMORIES.map((m) => m.id));
  for (const t of TRAJECTORIES) {
    for (const e of t.expect) expect(ids.has(e.id)).toBe(true);
    for (const a of t.allow ?? []) expect(ids.has(a)).toBe(true);
    if (t.lateEmergingId) expect(ids.has(t.lateEmergingId)).toBe(true);
  }
});

test("scoreBaseline computes recall/precision on a synthetic run", () => {
  const run: BaselineRun = {
    name: "synthetic",
    runs: [
      {
        trajectoryId: TRAJECTORIES[0]!.id, // dep-bun-conflict: bun r0/c2, auth r1, zod r2
        deliveries: [
          { seq: 0, id: "bun-not-npm", state: "relevant", renderedChars: 30 },
          { seq: 2, id: "bun-not-npm", state: "conflict", renderedChars: 30 },
          { seq: 1, id: "auth-server-side", state: "relevant", renderedChars: 30 },
          // zod-validation intentionally omitted → one missed relevance
        ],
        candidateCounts: [2, 2, 2],
        candidateIdsPerEvent: [["bun-not-npm"], ["auth-server-side"], ["bun-not-npm", "zod-validation"]],
        latenciesMs: [0.1, 0.1, 0.1],
      },
    ],
  };
  const r = scoreBaseline(run, [TRAJECTORIES[0]!]);
  expect(r.relevanceRecall).toEqual({ num: 2, den: 3 }); // bun, auth hit; zod missed
  expect(r.conflictRecall).toEqual({ num: 1, den: 1 });
  expect(r.taxonomy.missed_activation).toBe(1);
});

test("REGRESSION: stateless overseer saturates the trajectory benchmark", () => {
  const C = runOverseerBaseline("C", { useWorkflowState: false, useDecay: false });
  const report = scoreBaseline(C.run, TRAJECTORIES);
  expect(pct(report.relevanceRecall)).toBe(1);
  expect(pct(report.relevancePrecision)).toBe(1);
  expect(pct(report.conflictRecall)).toBe(1);
  expect(pct(report.conflictPrecision)).toBe(1);
  // No false interventions on the negative trajectories.
  expect(report.taxonomy.false_activation).toBe(0);
  expect(report.taxonomy.false_conflict).toBe(0);
  // Latency target (§25): p95 well under 10ms for evaluate-only.
  expect(report.latencyP95 ?? 99).toBeLessThan(10);
});

test("REGRESSION: Late-Emerging Context Recall beats prompt-only retrieval", () => {
  const seeded = seedCtx();
  try {
    const A = runPromptOnly(seeded.ctx);
    const C = runOverseerBaseline("C", { useWorkflowState: false, useDecay: false });
    const le = lateEmergingRecall(C.run, A, TRAJECTORIES);
    expect(pct(le.recall)).toBe(1); // overseer recovers every late-emerging key the prompt missed
    expect(pct(le.promptOnlyRecall)).toBeLessThan(1); // prompt-only genuinely could not
  } finally {
    seeded.cleanup();
  }
});
