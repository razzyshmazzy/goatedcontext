/**
 * Primary metrics (spec §22) computed from raw trial records.
 *
 * Every metric is reported per condition with a numerator/denominator and a Wilson 95%
 * interval (spec §23–24). Only scored outcomes (pass/fail) enter a rate; `unsupported`
 * and `infrastructure_error` are counted separately and NEVER silently folded into a
 * denominator (spec §32). "Adherence" means the preference was behaviorally applied when
 * it SHOULD be (appliesHere=true); the false-positive rate uses the appliesHere=false
 * trials, where applying the preference is the error (spec §16).
 */
import type { Condition, CtxFailureClass, TrialRecord } from "./results.ts";
import { describe, proportion, type Dist, type Proportion } from "./stats.ts";

const SCORED = new Set(["pass", "fail"]);
const scored = (r: TrialRecord) => SCORED.has(r.outcome);

function rateOf(records: TrialRecord[]): Proportion {
  const denom = records.filter(scored).length;
  const num = records.filter((r) => r.pass).length;
  return proportion(num, denom);
}

export interface ConditionMetrics {
  condition: Condition;
  /** §22.1 — applied when it should be (appliesHere=true). */
  adherence: Proportion;
  /** §22.2 — adherence restricted to fresh-session trials. */
  freshSessionRetention: Proportion;
  /** §22.3 — adherence restricted to cross-agent trials (source ≠ destination). */
  crossAgentRetention: Proportion;
  /** §22.4 — adherence restricted to heavy-interference trials. */
  heavyInterferenceRetention: Proportion;
  /** §22.5 — conditional precision: correct on BOTH match and non-match cases. */
  conditionalPrecision: Proportion;
  /** §22.6 — update accuracy: correction scenarios honoring the latest preference. */
  updateAccuracy: Proportion;
  /** §22.7 — poisoning resistance: adversarial content did not alter durable memory. */
  poisoningResistance: Proportion;
  /** §22.8 — false-positive rate: preference wrongly applied on appliesHere=false trials. */
  falsePositiveRate: Proportion;
  /** Outcome bookkeeping (never folded into rates). */
  counts: { pass: number; fail: number; unsupported: number; infrastructure_error: number; total: number };
}

function subset(records: TrialRecord[], pred: (r: TrialRecord) => boolean): TrialRecord[] {
  return records.filter(pred);
}

/**
 * The adherence predicate: positive-application trials (the preference legitimately
 * applies). A pass here means the agent behaved according to the preference.
 */
const positive = (r: TrialRecord) => r.appliesHere;

function falsePositive(records: TrialRecord[]): Proportion {
  // Among appliesHere=false scored trials, a "pass" means correct abstention; a fail means
  // the preference was wrongly applied. False-positive RATE = fails / scored.
  const neg = subset(records, (r) => !r.appliesHere && scored(r));
  const wronglyApplied = neg.filter((r) => !r.pass).length;
  return proportion(wronglyApplied, neg.length);
}

function conditionalPrecision(records: TrialRecord[]): Proportion {
  // Correct decisions among conditional scenarios across BOTH match and non-match.
  const cond = subset(records, (r) => r.category === "conditional" && scored(r));
  const correct = cond.filter((r) => r.pass).length;
  return proportion(correct, cond.length);
}

export function metricsFor(all: TrialRecord[], condition: Condition): ConditionMetrics {
  const records = all.filter((r) => r.condition === condition);
  const pos = subset(records, positive);
  return {
    condition,
    adherence: rateOf(pos),
    freshSessionRetention: rateOf(subset(pos, (r) => r.freshSession)),
    crossAgentRetention: rateOf(subset(pos, (r) => r.sourceAgent !== r.destinationAgent)),
    heavyInterferenceRetention: rateOf(subset(pos, (r) => r.interference === "heavy")),
    conditionalPrecision: conditionalPrecision(records),
    updateAccuracy: rateOf(subset(pos, (r) => r.category === "correction")),
    poisoningResistance: rateOf(subset(records, (r) => r.category === "poisoning" && scored(r))),
    falsePositiveRate: falsePositive(records),
    counts: {
      pass: records.filter((r) => r.outcome === "pass").length,
      fail: records.filter((r) => r.outcome === "fail").length,
      unsupported: records.filter((r) => r.outcome === "unsupported").length,
      infrastructure_error: records.filter((r) => r.outcome === "infrastructure_error").length,
      total: records.length,
    },
  };
}

export interface ContextCost {
  injectedChars: Dist;
  approxTokens: Dist;
  /** Tokens per SUCCESSFUL adherence event (spec §38): a cheap-and-effective check. */
  tokensPerSuccess: number;
}

export interface Latency {
  retrievalMs: Dist;
}

export interface CategoryBreakdown {
  category: string;
  byCondition: Record<string, Proportion>;
}

export interface RetentionPoint {
  interference: string;
  byCondition: Record<string, Proportion>;
}

export interface Summary {
  conditions: ConditionMetrics[];
  contextCost: ContextCost; // ctx condition only
  latency: Latency; // ctx condition only
  categories: CategoryBreakdown[];
  retentionCurve: RetentionPoint[];
  crossAgentMatrix: Array<{ source: string; destination: string; adherence: Proportion }>;
  ctxFailureBreakdown: Record<string, number>;
  totals: { trials: number; scenarios: number };
}

export function summarize(all: TrialRecord[], conditions: Condition[]): Summary {
  const conditionMetrics = conditions.map((c) => metricsFor(all, c));

  const ctx = all.filter((r) => r.condition === "ctx");
  const injectedChars = describe(ctx.map((r) => r.ctxInjectedChars).filter((n): n is number => n != null));
  const approxTokens = describe(ctx.map((r) => r.ctxApproxTokens).filter((n): n is number => n != null));
  const successes = ctx.filter((r) => r.appliesHere && r.outcome === "pass").length;
  const totalTokens = ctx.map((r) => r.ctxApproxTokens ?? 0).reduce((a, b) => a + b, 0);
  const retrievalMs = describe(ctx.map((r) => r.ctxRetrievalMs).filter((n): n is number => n != null));

  const categorySet = [...new Set(all.map((r) => r.category))];
  const categories: CategoryBreakdown[] = categorySet.map((category) => ({
    category,
    byCondition: Object.fromEntries(
      conditions.map((c) => [c, rateOf(all.filter((r) => r.category === category && r.condition === c && r.appliesHere))]),
    ),
  }));

  const levels = [...new Set(all.map((r) => r.interference))];
  const retentionCurve: RetentionPoint[] = levels.map((interference) => ({
    interference,
    byCondition: Object.fromEntries(
      conditions.map((c) => [c, rateOf(all.filter((r) => r.interference === interference && r.condition === c && r.appliesHere))]),
    ),
  }));

  // Cross-agent matrix: only populated cells (tested combinations) — never show 0 for
  // untested combinations (spec §37).
  const pairs = new Map<string, TrialRecord[]>();
  for (const r of all.filter((x) => x.appliesHere && x.condition === "ctx")) {
    const k = `${r.sourceAgent}→${r.destinationAgent}`;
    (pairs.get(k) ?? pairs.set(k, []).get(k)!).push(r);
  }
  const crossAgentMatrix = [...pairs.entries()].map(([k, recs]) => {
    const [source, destination] = k.split("→");
    return { source: source!, destination: destination!, adherence: rateOf(recs) };
  });

  const ctxFailureBreakdown: Record<string, number> = {};
  for (const r of all.filter((x) => x.condition === "ctx" && x.ctxFailureClass)) {
    const key = r.ctxFailureClass as Exclude<CtxFailureClass, null>;
    ctxFailureBreakdown[key] = (ctxFailureBreakdown[key] ?? 0) + 1;
  }

  return {
    conditions: conditionMetrics,
    contextCost: { injectedChars, approxTokens, tokensPerSuccess: successes > 0 ? totalTokens / successes : NaN },
    latency: { retrievalMs },
    categories,
    retentionCurve,
    crossAgentMatrix,
    ctxFailureBreakdown,
    totals: { trials: all.length, scenarios: new Set(all.map((r) => r.scenarioId)).size },
  };
}
