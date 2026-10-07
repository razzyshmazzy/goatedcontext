import type { RetrievalResult, RetrievedPreference } from "../retrieval/retrieval.ts";
import type { ObservedPattern } from "../signals/evidence.ts";
import { renderContextBlock } from "../render/context-block.ts";
import { MAX_RULE_CHARS } from "../preferences/types.ts";

/**
 * Bound a rule to the same cap the write path enforces, so a LEGACY oversized row
 * (written before the cap existed) can never flood the JSON/MCP transport with a
 * multi-megabyte value. New rules are already ≤ this at write time, so they pass
 * through untouched; only a legacy giant is truncated (with an ellipsis marker). The
 * STORED rule is never modified — this bounds OUTPUT only.
 */
function boundRule(rule: string): string {
  return rule.length <= MAX_RULE_CHARS ? rule : rule.slice(0, MAX_RULE_CHARS - 1) + "…";
}

/**
 * The STABLE, versioned machine contract for universal agent retrieval (0.4.0).
 *
 * This is the one envelope `ctx agent context --json` and the MCP `get_context`
 * tool both return, built from a single `RetrievalResult` so the two transports can
 * never diverge (CLI/MCP parity, spec §15). It is deliberately agent-neutral: an
 * integrating agent reads it without importing any goatedcontext TypeScript.
 *
 * Compatibility rule for `version: 1` (spec §14 / amendment 14):
 *   - ADDITIVE fields may appear within v1 (a consumer must ignore unknown fields);
 *   - existing fields keep their name, type and meaning;
 *   - a removal or type change requires a NEW envelope version (v2).
 * The envelope version is independent of the npm package version.
 *
 * Privacy (amendment 12): by default this exposes only what an integrating agent
 * needs to reason. It never returns absolute paths, the working directory, internal
 * database ids, session ids, agent/provenance ids, raw signal timestamps, or any
 * secret metadata. `observedPatterns` is already render-ready counts only.
 */
export const CONTEXT_ENVELOPE_VERSION = 1 as const;

/** One authoritative (in-effect) developer preference, stripped of internal identity. */
export interface EnvelopePreference {
  /** The behavior/default to honor. Raw text — the consuming agent decides how to use it. */
  rule: string;
  /** "global" | "repo". */
  scope: string;
  /** Decision domain when one is set, else null. */
  domain: string | null;
  /** "always" | "relevant" | "conditional". */
  applicability: string;
  /** Engine confidence in [0,1]. Presentation signal only; never identity. */
  confidence: number;
}

/**
 * A candidate (proposed/observed) preference. NON-authoritative by construction —
 * it only ever appears under `context.proposals`, never under
 * `authoritativePreferences`, and only when the caller opts in (`includeProposed`).
 */
export interface EnvelopeProposal {
  rule: string;
  scope: string;
  domain: string | null;
  applicability: string;
  confidence: number;
  /** Always true: a flat, explicit marker so a weak consumer cannot mistake it for a rule. */
  authoritative: false;
}

/**
 * Observed cross-repo decision evidence for one domain. Mirrors `ObservedPattern`
 * (already free of raw ids/timestamps). `canonical` is populated from the canonical
 * domain classifier (Phase 2); older constructors may leave it undefined.
 */
export interface EnvelopeObservedPattern {
  domain: string;
  /** Whether `domain` is in the recommended canonical vocabulary (Phase 2). */
  canonical?: boolean;
  choices: ObservedPattern["choices"];
  exceptions: ObservedPattern["exceptions"];
  /** True when more than one distinct choice was observed (no stable default). */
  contradictory: boolean;
}

/** Context-budget / token-growth instrumentation (spec §30; enriched in Phase 6). */
export interface EnvelopeDiagnostics {
  /** Applicability-matched candidates entering conflict resolution. */
  candidate: number;
  /** Winners after conflict/precedence resolution (the effective set). */
  effective: number;
  /** Authoritative preferences actually delivered in this envelope. */
  delivered: number;
  /** Alias of `delivered` for clarity (authoritative rules carried). */
  authoritative: number;
  /** Observed decision patterns carried. */
  observedPatterns: number;
  /** Characters of the canonical rendered text block (what a prompt-string agent injects). */
  renderedChars: number;
  /** Cheap deterministic token estimate (chars / 4). Not a tokenizer; indicative only. */
  approxTokens: number;
  /** Effective `relevant` winners dropped by the relevance top-K limit. */
  omittedByRelevance: number;
  /** Effective preferences dropped by an explicit delivery budget (0 when unlimited). */
  omittedByBudget: number;
  /**
   * True when ANY effective preference was omitted (relevance or budget). Lets a
   * consumer detect that it is not seeing the full authoritative set WITHOUT ctx
   * ever silently dropping an authoritative rule (spec §31).
   */
  overflow: boolean;
}

export interface ContextEnvelopeV1 {
  version: typeof CONTEXT_ENVELOPE_VERSION;
  context: {
    authoritativePreferences: EnvelopePreference[];
    observedPatterns: EnvelopeObservedPattern[];
    /** Present only when the caller passed `includeProposed`. Never authoritative. */
    proposals?: EnvelopeProposal[];
  };
  meta: {
    /** Whether retrieval resolved a git repository (boolean only — no path/id). */
    repo: boolean;
    /** The repo's display name when in a repo, else null. Never a path or internal id. */
    repoName: string | null;
    /** Canonical decision domains the task touched (drives signal surfacing). */
    domains: string[];
    diagnostics: EnvelopeDiagnostics;
  };
}

const ACTIVE = new Set(["approved", "locked"]);

function isAuthoritative(p: RetrievedPreference): boolean {
  return ACTIVE.has(p.status);
}

export interface BuildEnvelopeOptions {
  /** When true, include non-authoritative candidate preferences under `context.proposals`. */
  includeProposed?: boolean;
  /**
   * Optional domain classifier (Phase 2). Marks each observed pattern's domain as
   * canonical or custom. Omit and the `canonical` field is left undefined.
   */
  isCanonicalDomain?: (domain: string) => boolean;
}

/**
 * Build the stable v1 envelope from a single `RetrievalResult`. Pure and
 * deterministic; the ONLY shared retrieval-to-JSON path for every universal
 * transport. Does not read the filesystem, env, clock, or any mutable state.
 */
export function buildContextEnvelope(
  result: RetrievalResult,
  opts: BuildEnvelopeOptions = {},
): ContextEnvelopeV1 {
  const prefs = result.preferences ?? [];
  const authoritative = prefs.filter(isAuthoritative);
  const proposed = prefs.filter((p) => !isAuthoritative(p));
  const patterns = result.observedPatterns ?? [];

  // Rendered size is measured against the SAME canonical block a prompt-string agent
  // would inject — the authoritative-context projection (proposals never render here).
  const authoritativeResult: RetrievalResult = { ...result, preferences: authoritative };
  const block = renderContextBlock(authoritativeResult);
  const renderedChars = block ? block.length : 0;

  const d = result.delivery;
  const omittedByRelevance = d?.omittedByRelevanceLimit ?? 0;
  const omittedByBudget = d?.omittedByBudget ?? 0;
  // A force-kept single rule larger than the char budget is still over budget.
  const budgetExceeded = d?.budgetExceeded ?? false;

  const context: ContextEnvelopeV1["context"] = {
    authoritativePreferences: authoritative.map(toEnvelopePreference),
    observedPatterns: patterns.map((p) => toEnvelopePattern(p, opts.isCanonicalDomain)),
  };
  if (opts.includeProposed) {
    context.proposals = proposed.map(toEnvelopeProposal);
  }

  return {
    version: CONTEXT_ENVELOPE_VERSION,
    context,
    meta: {
      repo: Boolean(result.repo),
      repoName: result.repo ? result.repo.name : null,
      domains: result.signalEvidence?.consideredDomains ?? [],
      diagnostics: {
        candidate: d?.matched ?? authoritative.length,
        effective: d?.effective ?? authoritative.length,
        delivered: authoritative.length,
        authoritative: authoritative.length,
        observedPatterns: patterns.length,
        renderedChars,
        approxTokens: Math.ceil(renderedChars / 4),
        omittedByRelevance,
        omittedByBudget,
        overflow: omittedByRelevance > 0 || omittedByBudget > 0 || budgetExceeded,
      },
    },
  };
}

function toEnvelopePreference(p: RetrievedPreference): EnvelopePreference {
  return {
    rule: boundRule(p.rule),
    scope: p.scope,
    domain: p.domain ?? null,
    applicability: p.applicability,
    confidence: p.confidence,
  };
}

function toEnvelopeProposal(p: RetrievedPreference): EnvelopeProposal {
  return {
    rule: boundRule(p.rule),
    scope: p.scope,
    domain: p.domain ?? null,
    applicability: p.applicability,
    confidence: p.confidence,
    authoritative: false,
  };
}

function toEnvelopePattern(
  p: ObservedPattern,
  isCanonical?: (domain: string) => boolean,
): EnvelopeObservedPattern {
  const out: EnvelopeObservedPattern = {
    domain: p.domain,
    choices: p.choices,
    exceptions: p.exceptions,
    contradictory: p.contradictory,
  };
  if (isCanonical) out.canonical = isCanonical(p.domain);
  return out;
}
