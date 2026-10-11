/**
 * Markdown report generation (spec §43, §55–56).
 *
 * Produces a README-snippet from RAW results only — never hand-entered numbers. Every
 * rate carries its n (spec §23). The language is deliberately conservative: "adherence",
 * "retention", "persistent developer context" — never "100% memory" / "never forgets"
 * (spec §55). The snippet is written to the results dir for REVIEW; it never overwrites
 * the project README (spec §43).
 */
import type { Summary } from "./summarize.ts";
import { deltaPP, pctWithN, type Proportion } from "./stats.ts";
import type { Condition } from "./results.ts";

function find(summary: Summary, c: Condition) {
  return summary.conditions.find((m) => m.condition === c);
}

function deltaLine(label: string, ctx: Proportion | undefined, control: Proportion | undefined): string {
  if (!ctx || !control) return "";
  const d = deltaPP(ctx, control);
  const sign = d >= 0 ? "+" : "";
  const dStr = Number.isNaN(d) ? "n/a" : `${sign}${d.toFixed(0)} pp`;
  return `- **${label}** — control ${pctWithN(control)}, ctx ${pctWithN(ctx)} (**${dStr}**)`;
}

export interface ReportMeta {
  agentId: string;
  agentVersion: string;
  model: string;
  ctxSha: string;
  ctxVersion: string;
  trialsPerCell: number;
  date: string;
  deterministic: boolean;
  note: string;
}

export function renderReport(summary: Summary, meta: ReportMeta): string {
  const ctx = find(summary, "ctx");
  const control = find(summary, "control");
  const agentsmd = find(summary, "agentsmd");
  const L: string[] = [];

  L.push(`# Developer Preference Retention — ${meta.note}`);
  L.push("");
  L.push(
    `> Agent: \`${meta.agentId}\` (${meta.agentVersion}), model ${meta.model}. ` +
      `ctx ${meta.ctxVersion} @ \`${meta.ctxSha}\`. ${meta.trialsPerCell} trial(s)/cell. ${meta.date}. ` +
      `Scoring: ${meta.deterministic ? "deterministic (behavioral)" : "mixed — see notes"}.`,
  );
  L.push("");
  L.push(`Total trials: ${summary.totals.trials} across ${summary.totals.scenarios} scenarios.`);
  L.push("");

  // Headline deltas (spec §23).
  L.push("## Headline");
  L.push("");
  for (const line of [
    deltaLine("Preference adherence", ctx?.adherence, control?.adherence),
    deltaLine("Fresh-session retention", ctx?.freshSessionRetention, control?.freshSessionRetention),
    deltaLine("Heavy-interference retention", ctx?.heavyInterferenceRetention, control?.heavyInterferenceRetention),
    deltaLine("Cross-agent retention", ctx?.crossAgentRetention, control?.crossAgentRetention),
  ]) {
    if (line) L.push(line);
  }
  L.push("");

  // Main comparison table.
  L.push("## By condition");
  L.push("");
  const cols = summary.conditions.map((m) => m.condition);
  L.push(`| Metric | ${cols.join(" | ")} |`);
  L.push(`|---|${cols.map(() => "---").join("|")}|`);
  const row = (label: string, pick: (m: Summary["conditions"][number]) => Proportion) =>
    `| ${label} | ${summary.conditions.map((m) => pctWithN(pick(m))).join(" | ")} |`;
  L.push(row("Adherence", (m) => m.adherence));
  L.push(row("Fresh session", (m) => m.freshSessionRetention));
  L.push(row("Heavy interference", (m) => m.heavyInterferenceRetention));
  L.push(row("Conditional precision", (m) => m.conditionalPrecision));
  L.push(row("Update accuracy", (m) => m.updateAccuracy));
  L.push(row("Poisoning resistance", (m) => m.poisoningResistance));
  L.push(row("False-positive rate", (m) => m.falsePositiveRate));
  L.push("");

  // Retention curve (spec §36).
  L.push("## Retention vs interference");
  L.push("");
  L.push(`| Interference | ${cols.join(" | ")} |`);
  L.push(`|---|${cols.map(() => "---").join("|")}|`);
  for (const p of summary.retentionCurve) {
    L.push(`| ${p.interference} | ${cols.map((c) => pctWithN(p.byCondition[c]!)).join(" | ")} |`);
  }
  L.push("");

  // Context cost + latency (spec §38–39).
  L.push("## ctx cost & latency");
  L.push("");
  const cc = summary.contextCost;
  L.push(`- Injected chars — median ${fmt(cc.injectedChars.median)}, p95 ${fmt(cc.injectedChars.p95)}`);
  L.push(`- Approx tokens — median ${fmt(cc.approxTokens.median)}, p95 ${fmt(cc.approxTokens.p95)}`);
  L.push(`- Tokens per successful adherence — ${fmt(cc.tokensPerSuccess)}`);
  L.push(`- ctx retrieval overhead — median ${fmt(summary.latency.retrievalMs.median)} ms, p95 ${fmt(summary.latency.retrievalMs.p95)} ms`);
  L.push("");

  // Cross-agent matrix (only tested cells) — spec §37.
  if (summary.crossAgentMatrix.length > 0) {
    L.push("## Cross-agent (ctx condition)");
    L.push("");
    L.push("| Source → Destination | Adherence |");
    L.push("|---|---|");
    for (const cell of summary.crossAgentMatrix) {
      L.push(`| ${cell.source} → ${cell.destination} | ${pctWithN(cell.adherence)} |`);
    }
    L.push("");
  }

  // ctx failure taxonomy (spec §35).
  if (Object.keys(summary.ctxFailureBreakdown).length > 0) {
    L.push("## Where ctx trials failed");
    L.push("");
    for (const [k, v] of Object.entries(summary.ctxFailureBreakdown).sort((a, b) => b[1] - a[1])) {
      L.push(`- ${k}: ${v}`);
    }
    L.push("");
  }

  if (agentsmd) {
    L.push("> `agentsmd` is the static-AGENTS.md comparison condition (spec §3C).");
    L.push("");
  }
  L.push("_Generated from raw trial records. No numbers were hand-entered (spec §43–44)._");
  return L.join("\n");
}

function fmt(n: number): string {
  if (Number.isNaN(n)) return "n/a";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
