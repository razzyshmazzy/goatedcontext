/**
 * Scoring for the autonomous-pull benchmark.
 *
 * PURE functions only — no I/O, no model, no ctx. They turn trial records into the
 * five primary metrics (spec §11) and the failure taxonomy (spec §22). Every metric
 * is reported as an exact numerator/denominator pair; ratios are computed only when
 * the denominator is > 0, so a tiny-n pilot never fabricates a percentage (spec §16).
 */

/** One deterministic (no-model) retrieval check: does ctx return the right thing? */
export interface DeterministicResult {
  scenarioId: string;
  relevant: boolean;
  /** For a relevant scenario: did ctx return the expected preference? For an
   *  irrelevant one: did ctx (wrongly) return any preference? */
  retrievedExpected: boolean;
  returnedRuleCount: number;
  renderedChars: number;
  approxTokens: number;
}

/** One real-model pilot trial for a single scenario. */
export interface PilotTrial {
  scenarioId: string;
  relevant: boolean;
  /** Did the model autonomously invoke ctx (CLI `ctx get` or MCP get_context)? */
  calledCtx: boolean;
  /** The task/query string the model passed, if observable. */
  ctxQuery: string | null;
  /** Relevant+called: did ctx return the expected preference for the model's query? */
  retrievalReturnedExpected: boolean | null;
  /** Was the relevant context already pushed into the prompt this turn? (dedup, §19) */
  contextAlreadyPushed: boolean;
  /** retrievalReturnedExpected===true: did the model's behavior follow it? */
  adheredAfterPull: boolean | null;
  infraError: boolean;
  transcriptPath?: string;
  latencyMs?: number;
  /** Reported cost of this trial in USD, when the host provides it. */
  costUsd?: number | null;
}

export interface Fraction {
  num: number;
  den: number;
}

export interface MetricReport {
  toolRecall: Fraction;
  toolPrecision: Fraction;
  unnecessaryCallRate: Fraction;
  retrievalSuccessAfterCall: Fraction;
  adherenceAfterPull: Fraction;
  taxonomy: {
    no_call: number;
    bad_query: number;
    retrieval_miss: number;
    duplicate_call: number;
    unnecessary_call: number;
    adherence_failure: number;
    infrastructure_error: number;
  };
  /** Pull calls that duplicated already-pushed context (spec §19). */
  duplicateCallCount: number;
}

/** Format a fraction as "n/d" plus a percentage only when the denominator bites. */
export function fmtFraction(f: Fraction): string {
  if (f.den === 0) return `${f.num}/${f.den} (n/a — no cases)`;
  const pct = ((f.num / f.den) * 100).toFixed(0);
  return `${f.num}/${f.den} (${pct}%)`;
}

/**
 * Classify ONE relevant+called trial into the finer failure buckets using an optional
 * deterministic replay of the model's actual query. `canonicalRetrieves` is whether
 * the scenario's canonical probe retrieves the seed (it should, by construction).
 *   - model query missed, canonical hit  → bad_query (the model asked poorly)
 *   - model query missed, canonical miss → retrieval_miss (engine gap)
 */
export function classifyRelevantCall(
  t: PilotTrial,
  canonicalRetrieves: boolean,
): "ok" | "bad_query" | "retrieval_miss" {
  if (t.retrievalReturnedExpected) return "ok";
  return canonicalRetrieves ? "bad_query" : "retrieval_miss";
}

/**
 * Compute every primary metric + taxonomy from pilot trials.
 * `canonicalRetrievesById` maps scenarioId → whether its canonical probe retrieves the
 * seed deterministically (from the deterministic pass); used to split bad_query vs
 * retrieval_miss. Missing entries default to true (assume the engine can retrieve).
 */
export function scorePilot(
  trials: PilotTrial[],
  canonicalRetrievesById: Record<string, boolean> = {},
): MetricReport {
  const relevant = trials.filter((t) => t.relevant);
  const irrelevant = trials.filter((t) => !t.relevant);
  const called = trials.filter((t) => t.calledCtx);
  const relevantCalled = relevant.filter((t) => t.calledCtx);
  const retrievedExpected = relevantCalled.filter((t) => t.retrievalReturnedExpected === true);
  const adhered = retrievedExpected.filter((t) => t.adheredAfterPull === true);

  const taxonomy: MetricReport["taxonomy"] = {
    no_call: 0,
    bad_query: 0,
    retrieval_miss: 0,
    duplicate_call: 0,
    unnecessary_call: 0,
    adherence_failure: 0,
    infrastructure_error: 0,
  };

  for (const t of trials) {
    if (t.infraError) {
      taxonomy.infrastructure_error++;
      continue;
    }
    if (!t.relevant) {
      if (t.calledCtx) taxonomy.unnecessary_call++;
      continue;
    }
    // relevant
    if (!t.calledCtx) {
      taxonomy.no_call++;
      continue;
    }
    if (t.contextAlreadyPushed) {
      // Called even though the exact context was already injected (spec §19).
      taxonomy.duplicate_call++;
    }
    const verdict = classifyRelevantCall(t, canonicalRetrievesById[t.scenarioId] ?? true);
    if (verdict === "bad_query") taxonomy.bad_query++;
    else if (verdict === "retrieval_miss") taxonomy.retrieval_miss++;
    else if (t.adheredAfterPull === false) taxonomy.adherence_failure++;
  }

  return {
    toolRecall: { num: relevantCalled.length, den: relevant.length },
    toolPrecision: { num: relevantCalled.length, den: called.length },
    unnecessaryCallRate: { num: irrelevant.filter((t) => t.calledCtx).length, den: irrelevant.length },
    retrievalSuccessAfterCall: { num: retrievedExpected.length, den: relevantCalled.length },
    adherenceAfterPull: { num: adhered.length, den: retrievedExpected.length },
    taxonomy,
    duplicateCallCount: relevant.filter((t) => t.calledCtx && t.contextAlreadyPushed).length,
  };
}

/** Deterministic pass summary: retrieval correctness, independent of any model. */
export interface DeterministicSummary {
  relevantRetrieved: Fraction; // relevant scenarios where the seed WAS returned
  irrelevantClean: Fraction; // irrelevant scenarios where NOTHING was returned
  maxRenderedChars: number;
  maxApproxTokens: number;
  maxReturnedRuleCount: number;
}

export function summarizeDeterministic(results: DeterministicResult[]): DeterministicSummary {
  const relevant = results.filter((r) => r.relevant);
  const irrelevant = results.filter((r) => !r.relevant);
  return {
    relevantRetrieved: { num: relevant.filter((r) => r.retrievedExpected).length, den: relevant.length },
    // For irrelevant scenarios `retrievedExpected` means "wrongly returned something".
    irrelevantClean: { num: irrelevant.filter((r) => !r.retrievedExpected).length, den: irrelevant.length },
    maxRenderedChars: Math.max(0, ...results.map((r) => r.renderedChars)),
    maxApproxTokens: Math.max(0, ...results.map((r) => r.approxTokens)),
    maxReturnedRuleCount: Math.max(0, ...results.map((r) => r.returnedRuleCount)),
  };
}
