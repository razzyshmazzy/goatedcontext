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
import {
  RELEVANT,
  IRRELEVANT,
  ALL_SCENARIOS,
  PILOT_OBLIQUE,
  PILOT_OBLIQUE_RELEVANT,
  PILOT_OBLIQUE_NEG,
  PILOT_ENGINE,
} from "./scenarios.ts";
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
import {
  setupCorpusSandbox,
  runCorpus,
  summarize as summarizeCorpus,
  CORPUS,
  OBLIQUE_CALL,
} from "./retrieval-corpus.ts";
import { setupSemanticSandbox, runSemantic, summarizeSemantic } from "./semantic-corpus.ts";

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

/** Deterministic retrieval corpus (spec §14): engine recall/precision across classes. */
function cmdCorpus() {
  const sb = setupCorpusSandbox();
  try {
    const results = runCorpus(sb);
    const s = summarizeCorpus(results);
    const pct = (f: { num: number; den: number }) =>
      f.den === 0 ? `${f.num}/${f.den} (n/a)` : `${f.num}/${f.den} (${Math.round((f.num / f.den) * 100)}%)`;
    log("\n== Deterministic retrieval corpus (no model) ==\n");
    log("RELEVANT — [P]=raw-probe hit, [Q]=expanded-query hit:");
    for (const r of results.filter((x) => x.relevant)) {
      log(`  [${r.probeHit ? "P" : "-"}${r.queryHit ? "Q" : "-"}]  ${r.id.padEnd(20)} ${r.klass}`);
    }
    log("\nNEGATIVE — expect NOTHING (any surface is a leak):");
    for (const r of results.filter((x) => !x.relevant)) {
      log(`  ${r.probeHit || r.queryHit ? "✗ LEAK" : "✓"}  ${r.id.padEnd(20)} ${r.klass}`);
    }
    log("\nSummary (recall measured raw-probe vs expanded-query; §9 query-construction value):");
    log(`  cases                : ${CORPUS.length} (${s.relevant} relevant, ${s.negative} negative)`);
    log(`  probe recall         : ${pct(s.probeRecall)}   (raw terse prompt)`);
    log(`  query recall         : ${pct(s.queryRecall)}   (expanded semantic query)`);
    log(`  probe precision      : ${pct(s.probePrecision)}   (negatives clean)`);
    log(`  query precision      : ${pct(s.queryPrecision)}   (negatives clean)`);
    log("  per-class query recall:");
    for (const [k, v] of Object.entries(s.byClass)) log(`     ${k.padEnd(18)} ${pct(v)}`);
    const ok = s.queryPrecision.num === s.queryPrecision.den && s.queryRecall.num / s.queryRecall.den >= 0.9;
    log(`\n${ok ? "CORPUS PASS" : "CORPUS BELOW TARGET"}`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    sb.cleanup();
  }
}

/**
 * Focused OBLIQUE-CALL corpus (spec §6): does an oblique request's implied decision axis
 * map to a stored preference (should-call retrieval success), and do conceptual look-alikes
 * stay clean (should-not-call precision)? Isolated sandbox so it never perturbs CORPUS.
 */
function cmdOblique() {
  const sb = setupCorpusSandbox(OBLIQUE_CALL);
  try {
    const results = runCorpus(sb, OBLIQUE_CALL);
    const s = summarizeCorpus(results);
    const pct = (f: { num: number; den: number }) =>
      f.den === 0 ? `${f.num}/${f.den} (n/a)` : `${f.num}/${f.den} (${Math.round((f.num / f.den) * 100)}%)`;
    log("\n== Oblique-call corpus (no model) ==\n");
    log("SHOULD CALL — [P]=raw-probe hit, [Q]=expanded-query hit  (* = documented engine ceiling):");
    for (const r of results.filter((x) => x.relevant)) {
      const star = r.knownEngineMiss ? " *" : "";
      log(`  [${r.probeHit ? "P" : "-"}${r.queryHit ? "Q" : "-"}]  ${r.id.padEnd(20)} ${r.klass}${star}`);
    }
    log("\nSHOULD NOT CALL — expect NOTHING if queried (leak = engine surfaces an adjacent concept):");
    for (const r of results.filter((x) => !x.relevant)) {
      log(`  ${r.probeHit || r.queryHit ? "✗ LEAK" : "✓"}  ${r.id.padEnd(20)} ${r.klass}`);
    }
    log("\nSummary (recall = correctly-formed oblique query lands; precision = look-alikes clean):");
    const rel = results.filter((x) => x.relevant);
    const ceilings = rel.filter((x) => x.knownEngineMiss);
    const scored = rel.filter((x) => !x.knownEngineMiss);
    const barRecall = { num: scored.filter((x) => x.queryHit).length, den: scored.length };
    const leaks = results.filter((x) => !x.relevant && (x.probeHit || x.queryHit));
    log(`  cases                 : ${OBLIQUE_CALL.length} (${s.relevant} should-call, ${s.negative} should-not-call)`);
    log(`  should-call recall [P]: ${pct(s.probeRecall)}   (raw oblique prompt, no query construction)`);
    log(`  should-call recall [Q]: ${pct(s.queryRecall)}   (expanded semantic query, ALL cases)`);
    log(`  recall [Q] ex-ceiling : ${pct(barRecall)}   (excludes ${ceilings.length} documented engine ceiling(s): ${ceilings.map((c) => c.id).join(", ") || "none"})`);
    log(`  query-construction gain: +${s.queryRecall.num - s.probeRecall.num} cases (probe to query)`);
    log(`  should-not precision[Q]: ${pct(s.queryPrecision)}`);
    if (leaks.length) {
      log(`\n  ENGINE PRECISION NOTE: ${leaks.length} conceptual look-alike(s) surface a seed if queried verbatim:`);
      for (const l of leaks) log(`    - ${l.id} (adjacent to a seeded decision); defended by the no-call policy, not the engine.`);
    }
    // PASS when the layers THIS pass owns hit target: oblique query recall (excluding
    // documented engine ceilings) >= 90%. Engine precision/recall ceilings are reported, not gated.
    const ok = barRecall.den > 0 && barRecall.num / barRecall.den >= 0.9;
    log(`\n${ok ? "OBLIQUE CORPUS PASS (policy+query layer)" : "OBLIQUE CORPUS BELOW TARGET"}`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    sb.cleanup();
  }
}

/**
 * Focused retrieval-ENGINE corpus (spec §9–§11): semantic-equivalence / morphology /
 * proper-noun recall vs adjacent-topic & unrelated precision, in ONE multi-seed store.
 * Reports every §10 metric separately — no single aggregate hiding a tradeoff.
 */
function cmdSemantic() {
  const sb = setupSemanticSandbox();
  try {
    const results = runSemantic(sb);
    const s = summarizeSemantic(results);
    const pct = (f: { num: number; den: number }) =>
      f.den === 0 ? `${f.num}/${f.den} (n/a)` : `${f.num}/${f.den} (${Math.round((f.num / f.den) * 100)}%)`;
    log("\n== Retrieval-engine corpus (no model) ==\n");
    log("POSITIVES — [R]=recalled, [1]=ranked #1, n=returned count:");
    for (const r of results.filter((x) => x.recalled !== null)) {
      log(`  [${r.recalled ? "R" : "-"}${r.top1 ? "1" : "-"}] n=${r.returnedCount}  ${r.id.padEnd(16)} ${r.klass}`);
    }
    log("\nNEGATIVES — leak = a stored preference wrongly surfaced:");
    for (const r of results.filter((x) => x.leaked !== null)) {
      log(`  ${r.leaked ? "✗ LEAK" : "✓"}  n=${r.returnedCount}  ${r.id.padEnd(16)} ${r.klass}`);
    }
    log("\n== Metrics (each reported separately; spec §10) ==");
    log(`  morphology recall      : ${pct(s.morphologyRecall)}`);
    log(`  semantic-equiv recall  : ${pct(s.semanticRecall)}`);
    log(`  proper-noun recall     : ${pct(s.properNounRecall)}`);
    log(`  adjacent-topic precision: ${pct(s.adjacentPrecision)}`);
    log(`  unrelated precision    : ${pct(s.unrelatedPrecision)}`);
    log(`  top-1 accuracy         : ${pct(s.top1)}`);
    log(`  avg candidate count    : ${s.avgCandidates.toFixed(2)}`);
    log(`  false-positive rate    : ${pct(s.falsePositiveRate)}`);
    const posRecall =
      s.morphologyRecall.num + s.semanticRecall.num + s.properNounRecall.num;
    const posDen = s.morphologyRecall.den + s.semanticRecall.den + s.properNounRecall.den;
    const negNum = s.adjacentPrecision.num + s.unrelatedPrecision.num;
    const negDen = s.adjacentPrecision.den + s.unrelatedPrecision.den;
    log(`\n  overall positive recall: ${pct({ num: posRecall, den: posDen })}`);
    log(`  overall negative prec. : ${pct({ num: negNum, den: negDen })}`);
    const ok = posRecall / posDen >= 0.95 && negNum / negDen >= 0.95;
    log(`\n${ok ? "ENGINE CORPUS PASS (≥95/≥95)" : "ENGINE CORPUS BELOW 95/95 TARGET"}`);
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
  // --oblique: outcome-phrased call-recognition set (spec §8). --engine: retrieval-engine
  // validation set (spec §12, this pass). Otherwise the v1.1 set.
  const oblique = flags.oblique === true;
  const engine = flags.engine === true;
  const relPool = engine
    ? PILOT_ENGINE.filter((s) => s.relevant)
    : oblique
      ? PILOT_OBLIQUE_RELEVANT
      : RELEVANT;
  const irrPool = engine
    ? PILOT_ENGINE.filter((s) => !s.relevant)
    : oblique
      ? PILOT_OBLIQUE_NEG
      : IRRELEVANT;
  const presetAll = oblique || engine;
  const relN = flags.relevant != null ? Number(flags.relevant) : presetAll ? relPool.length : 3;
  const irrN = flags.irrelevant != null ? Number(flags.irrelevant) : presetAll ? irrPool.length : 3;
  const max = flags.max != null ? Number(flags.max) : HARD_CAP;
  const scenarios = [...relPool.slice(0, relN), ...irrPool.slice(0, irrN)];
  const seedScenarios = engine ? PILOT_ENGINE : oblique ? PILOT_OBLIQUE : RELEVANT;
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

  const sb: Sandbox = setupSandbox(seedScenarios);
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
  case "corpus":
    cmdCorpus();
    break;
  case "oblique":
    cmdOblique();
    break;
  case "semantic":
    cmdSemantic();
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
    log("usage: cli.ts <deterministic|corpus|oblique|semantic|parse-check|pilot|scenarios> [flags]");
    process.exitCode = 1;
}
