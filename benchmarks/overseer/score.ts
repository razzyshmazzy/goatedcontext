import type { Trajectory } from "./scenarios.ts";

/**
 * Pure scoring for the event-trajectory benchmark (§20, §21, §27). Operates on a
 * normalized per-baseline run so the same metrics apply to prompt-only retrieval,
 * every-event lexical retrieval, and the deterministic overseer variants.
 */
export interface DeliveryRecord {
  /** Event index the delivery fired at; -1 denotes prompt-time (baseline A). */
  seq: number;
  id: string;
  state: "relevant" | "conflict";
  renderedChars: number;
}

export interface TrajectoryRun {
  trajectoryId: string;
  deliveries: DeliveryRecord[];
  /** Candidate-set size per event (overseer only). */
  candidateCounts: number[];
  /** Candidate ids per event (overseer only) — used for candidate-miss taxonomy. */
  candidateIdsPerEvent: string[][];
  /** Per-event evaluation latency in ms (overseer only). */
  latenciesMs: number[];
}

export interface BaselineRun {
  name: string;
  runs: TrajectoryRun[];
}

export interface Fraction {
  num: number;
  den: number;
}

export interface Taxonomy {
  missed_activation: number;
  early_activation: number;
  false_activation: number;
  missed_conflict: number;
  false_conflict: number;
  duplicate_delivery: number;
  stale_delivery: number;
  wrong_scope: number;
  candidate_generation_miss: number;
  workflow_state_miss: number;
  host_adapter_error: number;
}

export interface MetricReport {
  baseline: string;
  relevanceRecall: Fraction;
  relevancePrecision: Fraction;
  conflictRecall: Fraction;
  conflictPrecision: Fraction;
  /** Mean event index of first delivery of each trajectory's late-emerging memory. */
  firstUsefulDeliveryMean: number | null;
  /** Mean useful lead time = expected conflict index − first relevant delivery index. */
  leadTimeMean: number | null;
  redundantDeliveriesPerSession: number;
  injectedCharsPerSession: number;
  candidatesPerEvent: number | null;
  latencyP50: number | null;
  latencyP95: number | null;
  taxonomy: Taxonomy;
}

function frac(num: number, den: number): Fraction {
  return { num, den };
}

export function pct(f: Fraction): number {
  return f.den === 0 ? 0 : f.num / f.den;
}

export function fmtFraction(f: Fraction): string {
  return `${f.num}/${f.den} (${Math.round(pct(f) * 100)}%)`;
}

function emptyTaxonomy(): Taxonomy {
  return {
    missed_activation: 0,
    early_activation: 0,
    false_activation: 0,
    missed_conflict: 0,
    false_conflict: 0,
    duplicate_delivery: 0,
    stale_delivery: 0,
    wrong_scope: 0,
    candidate_generation_miss: 0,
    workflow_state_miss: 0,
    host_adapter_error: 0,
  };
}

interface GroundTruth {
  expectedRelevant: Map<string, number>; // id → relevantAt
  expectedConflict: Map<string, number>; // id → conflictAt
  allow: Set<string>;
  lateEmergingId?: string;
}

function groundTruth(t: Trajectory): GroundTruth {
  const expectedRelevant = new Map<string, number>();
  const expectedConflict = new Map<string, number>();
  for (const e of t.expect) {
    if (e.relevantAt !== undefined) expectedRelevant.set(e.id, e.relevantAt);
    if (e.conflictAt !== undefined) expectedConflict.set(e.id, e.conflictAt);
  }
  return { expectedRelevant, expectedConflict, allow: new Set(t.allow ?? []), lateEmergingId: t.lateEmergingId };
}

/** Index deliveries by id → {relevant seqs, conflict seqs}. */
function indexDeliveries(d: DeliveryRecord[]): Map<string, { relevant: number[]; conflict: number[] }> {
  const m = new Map<string, { relevant: number[]; conflict: number[] }>();
  for (const r of d) {
    let e = m.get(r.id);
    if (!e) {
      e = { relevant: [], conflict: [] };
      m.set(r.id, e);
    }
    e[r.state].push(r.seq);
  }
  return m;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}

/** Score a baseline run against the trajectory ground truth. */
export function scoreBaseline(baseline: BaselineRun, trajectories: Trajectory[]): MetricReport {
  const byId = new Map(trajectories.map((t) => [t.id, t]));
  const tax = emptyTaxonomy();

  let relHitNum = 0,
    relHitDen = 0;
  let relPrecNum = 0,
    relPrecDen = 0;
  let conHitNum = 0,
    conHitDen = 0;
  let conPrecNum = 0,
    conPrecDen = 0;
  let redundant = 0;
  let injectedChars = 0;
  const firstUseful: number[] = [];
  const leadTimes: number[] = [];
  const allLatencies: number[] = [];
  let candTotal = 0,
    candEvents = 0;

  for (const run of baseline.runs) {
    const t = byId.get(run.trajectoryId);
    if (!t) continue;
    const gt = groundTruth(t);
    const idx = indexDeliveries(run.deliveries);

    // Relevance recall.
    for (const [id, at] of gt.expectedRelevant) {
      relHitDen++;
      const d = idx.get(id);
      if (d && d.relevant.length > 0) {
        relHitNum++;
        if (d.relevant[0]! < at) tax.early_activation++;
      } else {
        tax.missed_activation++;
        // Candidate-generation miss: never even a candidate at its expected event.
        if (run.candidateIdsPerEvent.length > at && !run.candidateIdsPerEvent[at]?.includes(id)) {
          tax.candidate_generation_miss++;
        }
      }
    }
    // Conflict recall.
    for (const [id] of gt.expectedConflict) {
      conHitDen++;
      const d = idx.get(id);
      if (d && d.conflict.length > 0) conHitNum++;
      else tax.missed_conflict++;
    }

    // Precision + redundancy + injected chars.
    const seenRelevant = new Set<string>();
    const seenConflict = new Set<string>();
    for (const r of run.deliveries) {
      injectedChars += r.renderedChars;
      if (r.state === "relevant") {
        relPrecDen++;
        const ok = gt.expectedRelevant.has(r.id) || gt.expectedConflict.has(r.id) || gt.allow.has(r.id);
        if (ok) relPrecNum++;
        else tax.false_activation++;
        if (seenRelevant.has(r.id)) {
          redundant++;
          tax.duplicate_delivery++;
        }
        seenRelevant.add(r.id);
      } else {
        conPrecDen++;
        if (gt.expectedConflict.has(r.id)) conPrecNum++;
        else tax.false_conflict++;
        if (seenConflict.has(r.id)) {
          redundant++;
          tax.duplicate_delivery++;
        }
        seenConflict.add(r.id);
      }
    }

    // First-useful + lead time for the late-emerging memory.
    if (gt.lateEmergingId) {
      const d = idx.get(gt.lateEmergingId);
      if (d) {
        const first = Math.min(...[...d.relevant, ...d.conflict]);
        if (Number.isFinite(first)) firstUseful.push(first);
      }
      const conflictAt = gt.expectedConflict.get(gt.lateEmergingId);
      if (conflictAt !== undefined && d && d.relevant.length > 0) {
        leadTimes.push(conflictAt - d.relevant[0]!);
      }
    }

    for (const c of run.candidateCounts) {
      candTotal += c;
      candEvents++;
    }
    for (const l of run.latenciesMs) allLatencies.push(l);
  }

  allLatencies.sort((a, b) => a - b);
  const sessions = baseline.runs.length || 1;

  return {
    baseline: baseline.name,
    relevanceRecall: frac(relHitNum, relHitDen),
    relevancePrecision: frac(relPrecNum, relPrecDen),
    conflictRecall: frac(conHitNum, conHitDen),
    conflictPrecision: frac(conPrecNum, conPrecDen),
    firstUsefulDeliveryMean: firstUseful.length ? mean(firstUseful) : null,
    leadTimeMean: leadTimes.length ? mean(leadTimes) : null,
    redundantDeliveriesPerSession: redundant / sessions,
    injectedCharsPerSession: injectedChars / sessions,
    candidatesPerEvent: candEvents ? candTotal / candEvents : null,
    latencyP50: allLatencies.length ? quantile(allLatencies, 0.5) : null,
    latencyP95: allLatencies.length ? quantile(allLatencies, 0.95) : null,
    taxonomy: tax,
  };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Late-Emerging Context Recall (§21): among trajectories whose key memory the
 * ORIGINAL PROMPT could not surface (prompt-only baseline A did NOT deliver it),
 * the fraction where the overseer DID deliver it. This is the metric the overseer
 * is built to win.
 */
export function lateEmergingRecall(
  overseer: BaselineRun,
  promptOnly: BaselineRun,
  trajectories: Trajectory[],
): { recall: Fraction; promptOnlyRecall: Fraction } {
  const over = new Map(overseer.runs.map((r) => [r.trajectoryId, r]));
  const prompt = new Map(promptOnly.runs.map((r) => [r.trajectoryId, r]));
  let num = 0,
    den = 0;
  let poNum = 0,
    poDen = 0;
  for (const t of trajectories) {
    if (!t.lateEmergingId) continue;
    const key = t.lateEmergingId;
    const promptDelivered = (prompt.get(t.id)?.deliveries ?? []).some((d) => d.id === key);
    const overDelivered = (over.get(t.id)?.deliveries ?? []).some((d) => d.id === key);
    poDen++;
    if (promptDelivered) poNum++;
    // The late-emerging denominator is trajectories the prompt alone could NOT get.
    if (!promptDelivered) {
      den++;
      if (overDelivered) num++;
    }
  }
  return { recall: frac(num, den), promptOnlyRecall: frac(poNum, poDen) };
}
