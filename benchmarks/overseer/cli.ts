import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GOLD_MEMORIES } from "./gold-specs.ts";
import { TRAJECTORIES } from "./scenarios.ts";
import {
  runEveryEventLexical,
  runOverseerBaseline,
  runPromptOnly,
  seedCtx,
  type DatasetRow,
} from "./harness.ts";
import {
  fmtFraction,
  lateEmergingRecall,
  type BaselineRun,
  type MetricReport,
  scoreBaseline,
} from "./score.ts";

/**
 * Event-trajectory benchmark runner (§18–§23). Runs the five baselines, prints the
 * metric table, computes Late-Emerging Context Recall, and persists a machine
 * dataset (§23) + a results JSON. Deterministic — no model calls.
 */

const RESULTS_DIR = join(process.cwd(), "benchmarks", "results", "overseer");

function reportLine(r: MetricReport): string {
  return [
    r.baseline.padEnd(34),
    `relR=${fmtFraction(r.relevanceRecall)}`.padEnd(20),
    `relP=${fmtFraction(r.relevancePrecision)}`.padEnd(20),
    `conR=${fmtFraction(r.conflictRecall)}`.padEnd(18),
    `conP=${fmtFraction(r.conflictPrecision)}`.padEnd(18),
  ].join(" ");
}

function detailLine(r: MetricReport): string {
  const p50 = r.latencyP50 === null ? "-" : `${r.latencyP50.toFixed(3)}ms`;
  const p95 = r.latencyP95 === null ? "-" : `${r.latencyP95.toFixed(3)}ms`;
  const cand = r.candidatesPerEvent === null ? "-" : r.candidatesPerEvent.toFixed(2);
  const first = r.firstUsefulDeliveryMean === null ? "-" : r.firstUsefulDeliveryMean.toFixed(2);
  const lead = r.leadTimeMean === null ? "-" : r.leadTimeMean.toFixed(2);
  return [
    r.baseline.padEnd(34),
    `redund/sess=${r.redundantDeliveriesPerSession.toFixed(2)}`.padEnd(20),
    `chars/sess=${r.injectedCharsPerSession.toFixed(0)}`.padEnd(18),
    `cand/ev=${cand}`.padEnd(14),
    `p50=${p50}`.padEnd(14),
    `p95=${p95}`.padEnd(14),
    `firstUseful=${first}`.padEnd(18),
    `lead=${lead}`,
  ].join(" ");
}

function run(): void {
  mkdirSync(RESULTS_DIR, { recursive: true });

  // Baselines A/B: real prompt-time retrieval over the seeded gold store.
  const seeded = seedCtx();
  let A: BaselineRun;
  let B: BaselineRun;
  try {
    A = runPromptOnly(seeded.ctx);
    B = runEveryEventLexical(seeded.ctx);
  } finally {
    seeded.cleanup();
  }

  // Baselines C/D/E: deterministic overseer.
  const C = runOverseerBaseline("C: activation (stateless)", { useWorkflowState: false, useDecay: false }, { collectDataset: true });
  const D = runOverseerBaseline("D: activation + workflow state", { useWorkflowState: true, useDecay: false });
  const E = runOverseerBaseline("E: activation + decay", { useWorkflowState: true, useDecay: true });

  const reports = [
    scoreBaseline(A, TRAJECTORIES),
    scoreBaseline(B, TRAJECTORIES),
    scoreBaseline(C.run, TRAJECTORIES),
    scoreBaseline(D.run, TRAJECTORIES),
    scoreBaseline(E.run, TRAJECTORIES),
  ];

  console.log("");
  console.log(`ctx Overseer event-trajectory benchmark — ${TRAJECTORIES.length} trajectories, ${GOLD_MEMORIES.length} gold memories`);
  console.log("=".repeat(118));
  for (const r of reports) console.log(reportLine(r));
  console.log("-".repeat(118));
  for (const r of reports) console.log(detailLine(r));
  console.log("=".repeat(118));

  const leA = lateEmergingRecall(C.run, A, TRAJECTORIES);
  const leD = lateEmergingRecall(D.run, A, TRAJECTORIES);
  const leE = lateEmergingRecall(E.run, A, TRAJECTORIES);
  console.log("");
  console.log("Late-Emerging Context Recall (memories the prompt alone could not surface):");
  console.log(`  prompt-only (A) recall of late-emerging keys: ${fmtFraction(leA.promptOnlyRecall)}`);
  console.log(`  overseer C (stateless):   ${fmtFraction(leA.recall)}`);
  console.log(`  overseer D (workflow):    ${fmtFraction(leD.recall)}`);
  console.log(`  overseer E (decay):       ${fmtFraction(leE.recall)}`);

  console.log("");
  console.log("Failure taxonomy (overseer C, stateless):");
  console.log(`  ${JSON.stringify(reports[2]!.taxonomy)}`);

  // Peak memory.
  const peak = process.memoryUsage().rss;
  console.log("");
  console.log(`peak RSS: ${(peak / 1024 / 1024).toFixed(1)} MB`);
  console.log("latency note: overseer p50/p95 are evaluate-only (specs preloaded, no DB on the hot path).");

  // Persist dataset (§23) + results JSON.
  const datasetPath = join(RESULTS_DIR, "dataset.jsonl");
  writeFileSync(datasetPath, C.dataset.map((r: DatasetRow) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const resultsPath = join(RESULTS_DIR, "results.json");
  writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        trajectories: TRAJECTORIES.length,
        goldMemories: GOLD_MEMORIES.length,
        reports,
        lateEmerging: { C: leA, D: leD, E: leE },
        peakRssBytes: peak,
        datasetRows: C.dataset.length,
      },
      null,
      2,
    ),
    "utf8",
  );
  // Emit the gold specs as a runnable sidecar artifact: copy to <ctx home>/
  // overseer-specs.json (or point CTX_OVERSEER_SPECS at it) to drive `ctx event`.
  const sidecarPath = join(RESULTS_DIR, "overseer-specs.json");
  writeFileSync(sidecarPath, JSON.stringify({ memories: GOLD_MEMORIES }, null, 2), "utf8");

  console.log(`dataset: ${datasetPath} (${C.dataset.length} rows)`);
  console.log(`results: ${resultsPath}`);
  console.log(`sidecar: ${sidecarPath} (copy to <ctx home>/overseer-specs.json for the live hook)`);
}

run();
