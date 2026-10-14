/**
 * Re-score a completed run from its PRESERVED raw transcripts (spec §5, §14).
 *
 * When a benchmark PARSER/SCORER/TAXONOMY bug is fixed, we do not need to spend money
 * re-running the model: the raw stream-json transcripts are immutable evidence of what the
 * agent actually did. This re-parses each transcript with the current parser, re-applies the
 * deterministic scorer and the ctx failure taxonomy, and writes a corrected summary next to
 * the originals (never overwriting them). Outcome classes other than pass/fail
 * (infrastructure_error, unsupported) are preserved as-is.
 *
 *   bun run benchmarks/developer-memory/src/rescore.ts <results-dir>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseStream } from "./adapters/claude-headless.ts";
import { score } from "./scorers.ts";
import { classifyCtxFailure, type Verification } from "./conditions.ts";
import { summarize } from "./summarize.ts";
import { renderReport } from "./report.ts";
import { byId } from "../scenarios/index.ts";
import type { TrialRecord, Outcome } from "./results.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun run rescore.ts <results-dir>");
  process.exit(1);
}

const recs: TrialRecord[] = readFileSync(join(dir, "trials.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as TrialRecord);

const verificationFrom = (r: TrialRecord): Verification => ({
  ctxDetected: r.ctxDetected,
  ctxPersisted: r.ctxPersisted,
  ctxRetrievalCalled: r.ctxRetrievalCalled,
  ctxDeliveredPreference: r.ctxDeliveredPreference,
  ctxInjectedChars: r.ctxInjectedChars,
  ctxApproxTokens: r.ctxApproxTokens,
  ctxRetrievalMs: r.ctxRetrievalMs,
  poisonRefused: r.poisonRefused ?? null,
});

const changes: string[] = [];
const corrected = recs.map((r) => {
  if (r.outcome !== "pass" && r.outcome !== "fail") return r; // keep infra/unsupported
  const scenario = byId(r.scenarioId);
  if (!scenario || !r.transcriptPath || !existsSync(r.transcriptPath)) return r;

  const { behavior } = parseStream(readFileSync(r.transcriptPath, "utf8"), ""); // repo="" → paths stay absolute; scorers key on ext/content/commands
  const verdict = score(scenario.scorer, behavior);
  const outcome: Outcome = verdict.pass ? "pass" : "fail";
  const ctxFailureClass =
    r.condition === "ctx" ? classifyCtxFailure(scenario, verificationFrom(r), verdict.pass, false) : null;

  if (outcome !== r.outcome || verdict.reason !== r.scoreReason || ctxFailureClass !== r.ctxFailureClass) {
    const cmds = behavior.commands.map((c) => c.replace(/^cd "[^"]*"\s*(&&|;)\s*/, "")).join(" | ") || "(none)";
    changes.push(
      `  ${r.scenarioId} ${r.condition}${r.freshSession ? "/fresh" : "/same"}: ` +
        `${r.outcome}→${outcome} [${r.ctxFailureClass ?? "-"}→${ctxFailureClass ?? "-"}]  cmds: ${cmds}`,
    );
  }
  return { ...r, outcome, pass: verdict.pass, scoreReason: verdict.reason, ctxFailureClass };
});

writeFileSync(join(dir, "trials.rescored.jsonl"), corrected.map((r) => JSON.stringify(r)).join("\n") + "\n");

const conditions = [...new Set(corrected.map((r) => r.condition))];
const summary = summarize(corrected, conditions);
writeFileSync(join(dir, "summary.rescored.json"), JSON.stringify(summary, null, 2));

const manifest = existsSync(join(dir, "manifest.json")) ? JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) : {};
const report = renderReport(summary, {
  agentId: manifest.agent?.id ?? "claude",
  agentVersion: manifest.agent?.version ?? "?",
  model: manifest.agent?.model ?? "?",
  ctxSha: (manifest.ctxGitSha ?? "").slice(0, 8),
  ctxVersion: manifest.ctxPackageVersion ?? "?",
  trialsPerCell: manifest.trialsPerCell ?? 1,
  date: manifest.date?.slice(0, 10) ?? "?",
  deterministic: true,
  note: "REAL CLAUDE PILOT (re-scored from preserved transcripts) — NOT FINAL BENCHMARK",
});
writeFileSync(join(dir, "README-snippet.rescored.md"), report);

console.log(`Re-scored ${corrected.length} trials from preserved transcripts.`);
console.log(changes.length ? `\nVerdict/label changes (${changes.length}):\n${changes.join("\n")}` : "\nNo verdict or label changes.");
console.log(`\n${report}`);
