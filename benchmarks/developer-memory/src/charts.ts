/**
 * Chart DATA export (spec §36, §44). We emit deterministic CSV/JSON only — no binary
 * rendering here, so the suite has zero plotting dependencies and the numbers are the
 * artifact. A downstream plotter (matplotlib/gnuplot/Observable) can turn these into
 * PNG/SVG; the CSVs are the reproducible source of truth.
 */
import type { Summary } from "./summarize.ts";
import type { Condition } from "./results.ts";

function rate(p: { rate: number }): string {
  return Number.isNaN(p.rate) ? "" : (p.rate * 100).toFixed(2);
}

/** retention_vs_interference.csv — one row per (interference level), columns per condition. */
export function retentionCsv(summary: Summary, conditions: Condition[]): string {
  const header = ["interference", ...conditions].join(",");
  const rows = summary.retentionCurve.map((p) =>
    [p.interference, ...conditions.map((c) => rate(p.byCondition[c]!))].join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}

/** condition_comparison.csv — adherence/fresh/heavy/etc per condition. */
export function conditionCsv(summary: Summary): string {
  const header = [
    "condition",
    "adherence",
    "fresh_session",
    "cross_agent",
    "heavy_interference",
    "conditional_precision",
    "update_accuracy",
    "poisoning_resistance",
    "false_positive_rate",
  ].join(",");
  const rows = summary.conditions.map((m) =>
    [
      m.condition,
      rate(m.adherence),
      rate(m.freshSessionRetention),
      rate(m.crossAgentRetention),
      rate(m.heavyInterferenceRetention),
      rate(m.conditionalPrecision),
      rate(m.updateAccuracy),
      rate(m.poisoningResistance),
      rate(m.falsePositiveRate),
    ].join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}

/** context_cost.csv — the ctx cost distribution (spec §38). */
export function contextCostCsv(summary: Summary): string {
  const c = summary.contextCost;
  const header = "metric,min,median,mean,p95,max";
  const row = (label: string, d: { min: number; median: number; mean: number; p95: number; max: number }) =>
    [label, d.min, d.median, d.mean.toFixed(1), d.p95, d.max].join(",");
  return [header, row("injected_chars", c.injectedChars), row("approx_tokens", c.approxTokens), row("retrieval_ms", summary.latency.retrievalMs)].join("\n") + "\n";
}

/** A single JSON blob with every chart's underlying data (spec §44 JSON export). */
export function chartsJson(summary: Summary, conditions: Condition[]): string {
  return JSON.stringify(
    {
      retentionVsInterference: summary.retentionCurve,
      conditionComparison: summary.conditions,
      contextCost: summary.contextCost,
      latency: summary.latency,
      crossAgentMatrix: summary.crossAgentMatrix,
      categories: summary.categories,
      conditions,
    },
    null,
    2,
  );
}
