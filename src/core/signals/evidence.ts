import type { RuntimeContext } from "../retrieval/runtime-context.ts";
import type { Preference } from "../preferences/types.ts";
import type { ChoiceEvidence, DomainEvidence, ExceptionEvidence } from "./service.ts";
import { canonicalDomain, collectDomainsFromText, taskSignalDomains } from "./domains.ts";

/**
 * Signal-evidence SELECTION (0.3.4).
 *
 * This is the pure, deterministic layer that decides which NON-authoritative signal
 * evidence (if any) is relevant to the current task and compact enough to surface.
 * It mutates nothing, promotes nothing, and establishes no default — it only turns
 * aggregated `DomainEvidence` into a small, ranked, budgeted set of `ObservedPattern`
 * objects for the renderer. The agent judges strength; ctx never does.
 *
 * Invariants:
 *  - Evidence is only ever considered for a canonical domain the TASK is about
 *    (`taskSignalDomains`). An unrelated prompt yields `[]`.
 *  - A matching explicit (approved/locked) preference SUPPRESSES ordinary competing
 *    signals for that domain — they must not read as competing instructions — but
 *    EXCEPTION evidence is kept, because a constrained exception is useful context.
 *  - Contradictions are preserved (never silently resolved by majority).
 *  - A hard OUTPUT budget bounds how much is surfaced; nothing is ever promoted.
 */

/** A single observed ordinary choice, render-ready (no raw ids/timestamps). */
export interface ObservedChoice {
  /** Display spelling of the choice (e.g. "Supabase"). */
  label: string;
  /** Distinct repositories this choice was seen in (breadth = the strongest signal). */
  distinctRepos: number;
  /** Distinct sessions, when the host supplied session ids. */
  distinctSessions: number;
  /** Raw observation count (presented secondarily to breadth). */
  observations: number;
  /** Whether it was seen in the CURRENT repo. */
  seenInCurrentRepo: boolean;
  /** Distinct OTHER repos (total minus the current one), for "also across N others". */
  otherRepos: number;
}

/** A single observed exception (a choice made against the usual preference). */
export interface ObservedException {
  label: string;
  /** The usually-preferred choice, when recorded. */
  preferredChoice: string | null;
  distinctRepos: number;
  seenInCurrentRepo: boolean;
  /** Distinct compact reasons, verbatim (never normalized). */
  reasons: string[];
  /** Distinct normalized constraint categories (e.g. "free-tier"). */
  constraints: string[];
}

/** Non-authoritative observed decision pattern for one canonical domain. */
export interface ObservedPattern {
  /** Canonical decision domain (e.g. "backend"). */
  domain: string;
  /** Ordinary choices, strongest (broadest) first. Empty when suppressed by a preference. */
  choices: ObservedChoice[];
  /** Exceptions, with reasons preserved. */
  exceptions: ObservedException[];
  /** True when more than one distinct ordinary choice was observed (no stable default). */
  contradictory: boolean;
  /** True when a current explicit preference already governs this domain. */
  hasExplicitPreference: boolean;
}

/**
 * The OUTPUT budget for signal evidence. Unlike always-on preferences (authoritative,
 * unbounded), evidence is optional context and is kept deliberately small so it can
 * never dominate the window. Values are evidence-driven, not thresholds: they bound
 * PRESENTATION only and never affect whether a pattern "counts".
 */
export interface SignalEvidenceBudget {
  /** Max distinct domains surfaced. */
  maxDomains: number;
  /** Max ordinary choices rendered per domain. */
  maxChoicesPerDomain: number;
  /** Max exceptions rendered per domain. */
  maxExceptionsPerDomain: number;
  /** Approximate max characters of evidence text across all domains. */
  maxChars: number;
}

export const DEFAULT_SIGNAL_EVIDENCE_BUDGET: SignalEvidenceBudget = {
  maxDomains: 3,
  maxChoicesPerDomain: 3,
  maxExceptionsPerDomain: 2,
  maxChars: 600,
};

export interface SignalEvidenceSelection {
  /** The patterns to surface (already ranked and budget-trimmed). */
  patterns: ObservedPattern[];
  /** Canonical domains matched to the task before budgeting (debug/`test-hook`). */
  consideredDomains: string[];
  /** How many matched domains were dropped by the output budget. */
  omittedByBudget: number;
}

/** The canonical domains a stored preference governs (its domain field + rule + category). */
function preferenceDomains(pref: Preference): Set<string> {
  const out = new Set<string>();
  if (pref.domain) out.add(canonicalDomain(pref.domain));
  for (const d of collectDomainsFromText(pref.rule)) out.add(d);
  if (pref.category) for (const d of collectDomainsFromText(pref.category)) out.add(d);
  return out;
}

function toObservedChoice(c: ChoiceEvidence): ObservedChoice {
  const seen = c.seenInCurrentRepo === true;
  return {
    label: c.label,
    distinctRepos: c.distinctRepos,
    distinctSessions: c.distinctSessions,
    observations: c.observations,
    seenInCurrentRepo: seen,
    otherRepos: Math.max(0, c.distinctRepos - (seen ? 1 : 0)),
  };
}

function toObservedException(e: ExceptionEvidence): ObservedException {
  return {
    label: e.label,
    preferredChoice: e.preferredChoice,
    distinctRepos: e.distinctRepos,
    seenInCurrentRepo: e.seenInCurrentRepo === true,
    reasons: e.reasons,
    constraints: e.constraints,
  };
}

/** Rough rendered-size estimate for one pattern, for the char budget (deterministic). */
function patternCost(p: ObservedPattern): number {
  let n = p.domain.length + 24; // header + framing
  for (const c of p.choices) n += c.label.length + 36;
  for (const e of p.exceptions) {
    n += e.label.length + (e.preferredChoice?.length ?? 0) + 24;
    n += e.reasons.join("; ").length;
    n += e.constraints.join(", ").length;
  }
  return n;
}

/**
 * Select the relevant, compact, non-authoritative signal evidence for a task.
 *
 * @param rc           the normalized runtime context (task/domain/repo)
 * @param evidence     canonical-domain aggregates (from `aggregateCanonical`)
 * @param authoritative the active approved/locked preferences (for suppression)
 * @param budget       output budget (presentation only)
 */
export function selectRelevantSignalEvidence(
  rc: RuntimeContext,
  evidence: DomainEvidence[],
  authoritative: Preference[],
  budget: SignalEvidenceBudget = DEFAULT_SIGNAL_EVIDENCE_BUDGET,
): SignalEvidenceSelection {
  const taskDomains = taskSignalDomains(rc);
  if (taskDomains.size === 0) {
    return { patterns: [], consideredDomains: [], omittedByBudget: 0 };
  }

  // Which domains already have a current explicit preference governing them.
  const prefDomains = new Set<string>();
  for (const p of authoritative) for (const d of preferenceDomains(p)) prefDomains.add(d);

  const primary = rc.domain ? canonicalDomain(rc.domain) : null;

  const built: ObservedPattern[] = [];
  for (const d of evidence) {
    if (!taskDomains.has(d.domain)) continue;
    const hasPref = prefDomains.has(d.domain);
    // A matching explicit preference suppresses ordinary competing signals, but
    // never the exception evidence (§7/§8) — a constrained exception stays useful.
    const ordinary = hasPref ? [] : d.choices.slice(0, budget.maxChoicesPerDomain).map(toObservedChoice);
    const exceptions = d.exceptions.slice(0, budget.maxExceptionsPerDomain).map(toObservedException);
    if (ordinary.length === 0 && exceptions.length === 0) continue;
    built.push({
      domain: d.domain,
      choices: ordinary,
      exceptions,
      contradictory: !hasPref && d.choices.length > 1,
      hasExplicitPreference: hasPref,
    });
  }

  // Deterministic ranking: the task's PRIMARY domain first, then by cross-repo
  // breadth, then observation volume, then recency-independent domain name. This is
  // a PRESENTATION order only — not a confidence score and never a promotion signal.
  const breadth = (p: ObservedPattern) =>
    Math.max(0, ...p.choices.map((c) => c.distinctRepos), ...p.exceptions.map((e) => e.distinctRepos));
  const volume = (p: ObservedPattern) =>
    p.choices.reduce((n, c) => n + c.observations, 0) + p.exceptions.length;
  built.sort(
    (a, b) =>
      Number(b.domain === primary) - Number(a.domain === primary) ||
      breadth(b) - breadth(a) ||
      volume(b) - volume(a) ||
      a.domain.localeCompare(b.domain),
  );

  const consideredDomains = built.map((p) => p.domain);

  // Apply the output budget: cap domains, then greedily keep within maxChars (always
  // keep at least the single most relevant pattern). Everything dropped is counted.
  let kept = built.slice(0, budget.maxDomains);
  const withinChars: ObservedPattern[] = [];
  let chars = 0;
  for (const p of kept) {
    const cost = patternCost(p);
    if (withinChars.length > 0 && chars + cost > budget.maxChars) break;
    withinChars.push(p);
    chars += cost;
  }
  kept = withinChars;

  return {
    patterns: kept,
    consideredDomains,
    omittedByBudget: built.length - kept.length,
  };
}
