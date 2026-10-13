/**
 * Autonomous-pull benchmark CLI.
 *
 *   bun run benchmarks/autonomous-pull/cli.ts deterministic
 *       No model. Seeds an isolated store and checks that ctx returns the expected
 *       preference for every relevant task and nothing for every irrelevant one,
 *       plus response size. This must pass before any real-model trial (spec §12).
 *
 *   bun run benchmarks/autonomous-pull/cli.ts pilot [--max N] [--relevant K] [--irrelevant K]
 *       HARD-CAPPED real-model pilot (spec §14–§15). Prints the plan + cost guard and
 *       STOPS if planned calls exceed the cap (default/absolute 10). Requires
 *       CTXBENCH_ENABLE_CLAUDE=1 and CTXBENCH_MODEL=<model>. Prints every metric as an
 *       exact numerator/denominator (spec §11, §16) and the failure taxonomy (§22).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELEVANT, IRRELEVANT, ALL_SCENARIOS } from "./scenarios.ts";
import {
  setupSandbox,
  deterministicPass,
  runPilot,
  claudeVersion,
  type Sandbox,
} from "./harness.ts";
import {
  summarizeDeterministic,
  scorePilot,
  fmtFraction,
  type DeterministicResult,
  type PilotTrial,
} from "./score.ts";

const HARD_CAP = 10; // spec §14: MAXIMUM 10 real model calls.

function log(s = "") {
  process.stdout.write(s + "\n");
}

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else out[key] = true;
    }
  }
  return out;
}

function printDeterministic(results: DeterministicResult[]) {
  log("\n== Deterministic retrieval pass (no model) ==\n");
  log("RELEVANT — expect the seeded preference to be returned:");
  for (const r of results.filter((x) => x.relevant)) {
    const mark = r.retrievedExpected ? "✓" : "✗ MISS";
    log(`  ${mark}  ${r.scenarioId.padEnd(26)} rules=${r.returnedRuleCount} chars=${r.renderedChars}`);
  }
  log("\nIRRELEVANT — expect NOTHING relevant to be returned:");
  for (const r of results.filter((x) => !x.relevant)) {
    const mark = r.retrievedExpected ? "✗ LEAK" : "✓";
    log(`  ${mark}  ${r.scenarioId.padEnd(26)} rules=${r.returnedRuleCount} chars=${r.renderedChars}`);
  }
  const s = summarizeDeterministic(results);
  log("\nSummary:");
  log(`  relevant retrieved : ${fmtFraction(s.relevantRetrieved)}`);
  log(`  irrelevant clean   : ${fmtFraction(s.irrelevantClean)}`);
  log(`  max rendered chars : ${s.maxRenderedChars} (~${s.maxApproxTokens} tokens)`);
  log(`  max prefs returned : ${s.maxReturnedRuleCount}`);
}

function cmdDeterministic() {
  const sb = setupSandbox();
  try {
    const results = deterministicPass(sb);
    printDeterministic(results);
    const s = summarizeDeterministic(results);
    const ok = s.relevantRetrieved.num === s.relevantRetrieved.den && s.irrelevantClean.num === s.irrelevantClean.den;
    log(`\n${ok ? "DETERMINISTIC PASS" : "DETERMINISTIC INCOMPLETE (see MISS/LEAK above)"}`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    sb.cleanup();
  }
}

/** Show that tool-call capture works WITHOUT a model: parse a synthetic transcript. */
function cmdParseCheck() {
  const fixture = [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: 'ctx get --cwd "." --task "add uuid"' } }] },
    }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "I'll use nanoid per your preference." }] } }),
    JSON.stringify({ type: "result", result: "done", total_cost_usd: 0.012 }),
  ].join("\n");
  // Lazy import to avoid pulling spawn paths here.
  import("./harness.ts").then(({ parseStream, isCtxGetCommand, extractTaskArg }) => {
    const p = parseStream(fixture);
    const called = p.commands.some(isCtxGetCommand);
    const task = p.commands.map(extractTaskArg).find(Boolean) ?? null;
    log("== Tool-call capture check (synthetic, no model) ==");
    log(`  commands observed : ${JSON.stringify(p.commands)}`);
    log(`  ctx call detected : ${called}`);
    log(`  extracted --task  : ${JSON.stringify(task)}`);
    log(`  final text        : ${JSON.stringify(p.finalText)}`);
    log(`  cost parsed       : ${p.costUsd}`);
    const ok = called && task === "add uuid" && p.costUsd === 0.012;
    log(`\n${ok ? "CAPTURE OK" : "CAPTURE BROKEN"}`);
    process.exitCode = ok ? 0 : 1;
  });
}

async function cmdPilot(flags: Record<string, string | boolean>) {
  const relN = flags.relevant != null ? Number(flags.relevant) : 3;
  const irrN = flags.irrelevant != null ? Number(flags.irrelevant) : 3;
  const max = flags.max != null ? Number(flags.max) : HARD_CAP;
  const scenarios = [...RELEVANT.slice(0, relN), ...IRRELEVANT.slice(0, irrN)];
  const planned = scenarios.length; // one trial each
  const model = process.env.CTXBENCH_MODEL ?? null;
  const enabled = process.env.CTXBENCH_ENABLE_CLAUDE === "1";
  const version = claudeVersion();

  // ---- Cost guard (spec §15) ------------------------------------------------
  log("== Real-model pilot — cost guard ==");
  log(`  planned scenarios : ${scenarios.map((s) => s.id).join(", ")}`);
  log(`  planned invocations: ${planned} (1 trial each)`);
  log(`  model             : ${model ?? "(unset — set CTXBENCH_MODEL)"}`);
  log(`  claude binary     : ${version ?? "(unavailable)"}`);
  log(`  hard cap          : ${HARD_CAP}`);
  log(`  rough cost        : ~$0.01–0.05 per short Sonnet trial → ~$${(planned * 0.03).toFixed(2)} total (exact cost reported post-run)`);

  if (planned > Math.min(max, HARD_CAP)) {
    log(`\nSTOP: planned ${planned} > cap ${Math.min(max, HARD_CAP)}. Refusing to expand the run (spec §15).`);
    process.exitCode = 1;
    return;
  }
  if (!enabled || !model) {
    log("\nGATED: set CTXBENCH_ENABLE_CLAUDE=1 and CTXBENCH_MODEL=<model> to run live. No calls made.");
    process.exitCode = 0;
    return;
  }
  if (!version) {
    log("\nABORT: `claude` binary not found. No calls made.");
    process.exitCode = 1;
    return;
  }

  const transcriptDir =
    (typeof flags.transcriptDir === "string" && flags.transcriptDir) ||
    join(process.cwd(), "benchmarks", "results", "autonomous-pull-transcripts");
  mkdirSync(transcriptDir, { recursive: true });

  const sb: Sandbox = setupSandbox();
  let trials: PilotTrial[] = [];
  try {
    // Deterministic truth for each scenario's canonical probe (splits bad_query vs miss).
    const det = deterministicPass(sb, scenarios);
    const canonical: Record<string, boolean> = {};
    for (const d of det) canonical[d.scenarioId] = d.relevant ? d.retrievedExpected : true;

    log(`\nRunning ${planned} live trials sequentially…`);
    trials = await runPilot(sb, { model, transcriptDir, scenarios });
    printPilot(trials, canonical, transcriptDir);
  } finally {
    sb.cleanup();
  }
}

function printPilot(trials: PilotTrial[], canonical: Record<string, boolean>, transcriptDir: string) {
  log("\n== Pilot per-trial ==");
  for (const t of trials) {
    const bits = [
      t.calledCtx ? "called" : "NO-call",
      t.relevant ? "relevant" : "irrelevant",
      t.retrievalReturnedExpected == null ? "" : `retr=${t.retrievalReturnedExpected}`,
      t.adheredAfterPull == null ? "" : `adhered=${t.adheredAfterPull}`,
      t.infraError ? "INFRA-ERR" : "",
      t.latencyMs != null ? `${t.latencyMs}ms` : "",
      t.costUsd != null ? `$${t.costUsd}` : "",
    ].filter(Boolean);
    log(`  ${t.scenarioId.padEnd(26)} ${bits.join("  ")}`);
    if (t.ctxQuery) log(`      query: ${JSON.stringify(t.ctxQuery)}`);
  }

  const m = scorePilot(trials, canonical);
  const totalCost = trials.reduce((a, t) => a + (t.costUsd ?? 0), 0);
  log("\n== Metrics (exact numerator/denominator; spec §11, §16) ==");
  log(`  Tool Recall                 : ${fmtFraction(m.toolRecall)}`);
  log(`  Tool Precision              : ${fmtFraction(m.toolPrecision)}`);
  log(`  Unnecessary Call Rate       : ${fmtFraction(m.unnecessaryCallRate)}`);
  log(`  Retrieval Success After Call: ${fmtFraction(m.retrievalSuccessAfterCall)}`);
  log(`  Adherence After Pull        : ${fmtFraction(m.adherenceAfterPull)}`);
  log("\n== Failure taxonomy (spec §22) ==");
  for (const [k, v] of Object.entries(m.taxonomy)) log(`  ${k.padEnd(22)}: ${v}`);
  log(`  duplicate-call count  : ${m.duplicateCallCount}`);
  log(`\n  total reported cost   : $${totalCost.toFixed(4)}`);
  log(`  transcripts           : ${transcriptDir}`);

  // Persist a machine-readable artifact for the report.
  try {
    const out = join(transcriptDir, "pilot-result.json");
    writeFileSync(out, JSON.stringify({ trials, metrics: m, totalCost }, null, 2));
    log(`  result artifact       : ${out}`);
  } catch {
    /* best effort */
  }
}

const [, , cmd, ...rest] = process.argv;
const flags = parseFlags(rest);
switch (cmd) {
  case "deterministic":
    cmdDeterministic();
    break;
  case "parse-check":
    cmdParseCheck();
    break;
  case "pilot":
    await cmdPilot(flags);
    break;
  case "scenarios":
    log(`${ALL_SCENARIOS.length} scenarios: ${RELEVANT.length} relevant + ${IRRELEVANT.length} irrelevant`);
    for (const s of ALL_SCENARIOS) log(`  ${s.relevant ? "R" : "N"}  ${s.id.padEnd(26)} ${JSON.stringify(s.probe)}`);
    break;
  default:
    log("usage: cli.ts <deterministic|parse-check|pilot|scenarios> [flags]");
    process.exitCode = 1;
}
