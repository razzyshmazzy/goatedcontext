/**
 * Benchmark CLI (spec §29, §30, §45, §46).
 *
 *   bun run bench:memory:demo                  # 5 scenarios, control vs ctx, mock agent
 *   bun run bench:memory -- --dry-run          # validate + print the plan, no agent calls
 *   bun run bench:memory -- --agent mock --trials 3
 *   bun run bench:memory:full -- --agent claude --yes
 *
 * Defaults are safe: the mock agent (no cost), control+ctx, 1 trial, dev split. A paid
 * agent requires both its enabling env var AND an explicit --yes, and the planned size is
 * always printed first so a typo can never launch thousands of paid sessions (spec §30).
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { ALL_SCENARIOS, devScenarios, heldoutScenarios, demoScenarios, byId, datasetCounts } from "../scenarios/index.ts";
import type { Scenario, Category } from "./schema.ts";
import { validateScenario } from "./schema.ts";
import { MockAgent } from "./adapters/mock.ts";
import { ClaudeHeadlessAgent } from "./adapters/claude-headless.ts";
import type { AgentAdapter } from "./adapters/types.ts";
import { ResultStore, type Condition } from "./results.ts";
import { runBenchmark, planSummary, setArtifactWriter, type RunConfig } from "./runner.ts";
import { summarize } from "./summarize.ts";
import { renderReport } from "./report.ts";
import { retentionCsv, conditionCsv, contextCostCsv, chartsJson } from "./charts.ts";
import { buildManifest } from "./manifest.ts";
import { REPO_ROOT } from "./ctx-integration.ts";

interface Args {
  mode: "run" | "demo" | "full";
  agent: string;
  conditions: Condition[];
  categories: Category[];
  scenarioIds: string[];
  split: "dev" | "heldout" | "all";
  trials: number;
  seed: number;
  fresh: boolean;
  sweep: boolean;
  maxScenarios?: number;
  maxTrials?: number;
  dryRun: boolean;
  yes: boolean;
  runId?: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    mode: "run",
    agent: "mock",
    conditions: [],
    categories: [],
    scenarioIds: [],
    split: "dev",
    trials: 1,
    seed: 1234,
    fresh: false,
    sweep: false,
    dryRun: false,
    yes: false,
    out: join(REPO_ROOT, "benchmarks", "results"),
  };
  const rest = [...argv];
  if (rest[0] === "demo" || rest[0] === "full" || rest[0] === "run") a.mode = rest.shift() as Args["mode"];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    const next = () => rest[++i]!;
    switch (t) {
      case "--agent": a.agent = next(); break;
      case "--condition": a.conditions.push(next() as Condition); break;
      case "--category": a.categories.push(next() as Category); break;
      case "--scenario": a.scenarioIds.push(next()); break;
      case "--split": a.split = next() as Args["split"]; break;
      case "--trials": a.trials = int(next(), "--trials"); break;
      case "--seed": a.seed = int(next(), "--seed"); break;
      case "--fresh": a.fresh = true; break;
      case "--sweep": a.sweep = true; break;
      case "--max-scenarios": a.maxScenarios = int(next(), "--max-scenarios"); break;
      case "--max-trials": a.maxTrials = int(next(), "--max-trials"); break;
      case "--dry-run": a.dryRun = true; break;
      case "--yes": case "--execute": a.yes = true; break;
      case "--run-id": a.runId = next(); break;
      case "--out": a.out = next(); break;
      default:
        if (t && t.startsWith("--")) throw new Error(`unknown flag: ${t}`);
    }
  }
  return a;
}

function int(s: string, flag: string): number {
  if (!/^\d+$/.test(s)) throw new Error(`${flag} expects a whole number, got "${s}"`);
  return Number(s);
}

function selectScenarios(a: Args): Scenario[] {
  if (a.mode === "demo") return demoScenarios();
  let pool: Scenario[] =
    a.split === "dev" ? devScenarios() : a.split === "heldout" ? heldoutScenarios() : ALL_SCENARIOS;
  if (a.mode === "full") pool = ALL_SCENARIOS;
  if (a.scenarioIds.length > 0) pool = a.scenarioIds.map((id) => byId(id)).filter((s): s is Scenario => Boolean(s));
  if (a.categories.length > 0) pool = pool.filter((s) => a.categories.includes(s.category));
  if (a.maxScenarios != null) pool = pool.slice(0, a.maxScenarios);
  return pool;
}

function resolveAgent(id: string): AgentAdapter {
  if (id === "mock") return new MockAgent();
  if (id === "claude") return new ClaudeHeadlessAgent();
  throw new Error(`unknown agent "${id}" (known: mock, claude)`);
}

function defaultConditions(a: Args): Condition[] {
  if (a.conditions.length > 0) return a.conditions;
  if (a.mode === "demo") return ["control", "ctx"];
  return ["control", "ctx"];
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const scenarios = selectScenarios(a);
  const conditions = defaultConditions(a);
  const agent = resolveAgent(a.agent);
  const now = new Date().toISOString();

  // Demo is capped tight regardless (spec §45).
  const trials = a.mode === "demo" ? Math.min(a.trials, 3) : a.trials;

  const cfg: RunConfig = {
    scenarios,
    conditions,
    trials,
    seed: a.seed,
    freshSession: a.fresh,
    depthSweep: a.sweep,
    maxTrials: a.maxTrials,
    now,
  };

  const plan = planSummary(cfg);
  const counts = datasetCounts();

  console.log(`\ngoatedcontext developer-memory benchmark`);
  console.log(`dataset: ${counts.total} scenarios (dev=${counts.bySplit.dev ?? 0}, heldout=${counts.bySplit.heldout ?? 0})`);
  console.log(`\nPlanned run:`);
  console.log(`  agent:       ${agent.id}`);
  console.log(`  scenarios:   ${plan.scenarios}`);
  console.log(`  conditions:  ${plan.conditions.join(", ")}`);
  console.log(`  trials/cell: ${plan.trialsPerCell}`);
  console.log(`  fresh:       ${plan.freshSession}   sweep: ${plan.depthSweep}`);
  console.log(`  TOTAL agent invocations: ${a.maxTrials != null ? Math.min(a.maxTrials, plan.totalTasks) : plan.totalTasks}`);

  if (a.dryRun) {
    let problems = 0;
    for (const s of scenarios) problems += validateScenario(s).length;
    console.log(`\n--dry-run: validated ${scenarios.length} scenarios, ${problems} problems. No agent was called.`);
    return;
  }

  // Cost guardrail (spec §30): a non-mock agent needs an explicit --yes.
  if (agent.id !== "mock" && !a.yes) {
    console.log(`\nRefusing to run a paid agent without --yes. Re-run with --yes to execute ${plan.totalTasks} sessions.`);
    process.exitCode = 2;
    return;
  }
  if (!(await agent.available())) {
    console.log(`\nAgent "${agent.id}" is not available here (binary/credentials/enable-flag missing). Aborting.`);
    process.exitCode = 2;
    return;
  }

  const runId = a.runId ?? `${now.slice(0, 10)}_${agent.id}_s${a.seed}`;
  const store = new ResultStore(a.out, runId);
  setArtifactWriter((key, body) => store.writeFailureArtifact(key, body));

  const manifest = buildManifest({
    scenarios,
    agent: { id: agent.id, version: String(await agent.version()), model: process.env.CTXBENCH_MODEL ?? "unspecified" },
    seed: a.seed,
    date: now,
    trialsPerCell: trials,
    conditions,
    runId,
  });
  store.writeManifest(manifest);
  console.log(`\nrun-id: ${runId}  (results → ${store.dir})`);
  console.log(`benchmark: ${manifest.benchmarkVersion}  dataset-hash: ${manifest.datasetHash}  ctx: ${manifest.ctxPackageVersion}@${manifest.ctxGitSha.slice(0, 8)}\n`);

  await runBenchmark(cfg, agent, store, {
    onTrial: (rec, i, total) => {
      const mark = rec.outcome === "pass" ? "PASS" : rec.outcome === "fail" ? "FAIL" : rec.outcome === "unsupported" ? "skip" : "ERR ";
      console.log(`  [${String(i).padStart(3)}/${total}] ${mark} ${rec.condition.padEnd(8)} ${rec.scenarioId}${rec.freshSession ? " (fresh)" : ""}`);
    },
  });

  // Summaries + artifacts from RAW records only.
  const all = store.readAll();
  const summary = summarize(all, conditions);
  store.writeSummary(summary);

  const reportMeta = {
    agentId: agent.id,
    agentVersion: manifest.agent.version,
    model: manifest.agent.model,
    ctxSha: manifest.ctxGitSha.slice(0, 8),
    ctxVersion: manifest.ctxPackageVersion,
    trialsPerCell: trials,
    date: now.slice(0, 10),
    deterministic: true,
    note: agent.id === "mock" ? "PILOT (mock agent — harness validation, NOT a model result)" : "pilot",
  };
  const report = renderReport(summary, reportMeta);
  writeText(join(store.dir, "README-snippet.md"), report);
  writeText(join(store.dir, "retention_vs_interference.csv"), retentionCsv(summary, conditions));
  writeText(join(store.dir, "condition_comparison.csv"), conditionCsv(summary));
  writeText(join(store.dir, "context_cost.csv"), contextCostCsv(summary));
  writeText(join(store.dir, "charts.json"), chartsJson(summary, conditions));

  console.log(`\n${report}\n`);
  console.log(`Artifacts written to ${store.dir}`);
  if (agent.id === "mock") {
    console.log(`\nNOTE: mock-agent numbers validate the HARNESS only. Real results require --agent claude (gated).`);
  }
}

function writeText(path: string, body: string): void {
  writeFileSync(path, body);
}

void (async () => {
  try {
    await main();
  } catch (err) {
    console.error(`\nbenchmark error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
})();
