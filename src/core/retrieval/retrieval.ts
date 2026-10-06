import type { Database } from "../../storage/sqlite/driver.ts";
import type { Preference } from "../preferences/types.ts";
import type { PreferenceService } from "../preferences/service.ts";
import type { RepoService, Repo } from "../repos/repo.ts";
import type { EnvironmentService } from "../environments/service.ts";
import {
  contentTokens,
  inferDomains,
  isExclusiveDomain,
  stem,
  subjectKey,
  subjectTokens,
} from "../preferences/analysis.ts";
import { precedenceRank } from "./precedence.ts";
import { withReadTx } from "../../storage/sqlite/tx.ts";
import type { Condition } from "../preferences/conditions.ts";
import { buildRuntimeContext, type RuntimeContext } from "./runtime-context.ts";
import { evaluateCondition } from "./evaluate.ts";
import type { SignalService } from "../signals/service.ts";
import { taskSignalDomains } from "../signals/domains.ts";
import {
  selectRelevantSignalEvidence,
  DEFAULT_SIGNAL_EVIDENCE_BUDGET,
  type ObservedPattern,
  type SignalEvidenceBudget,
} from "../signals/evidence.ts";

/** Minimum relevance to be returned. Below this, a preference is dropped. */
const RELEVANCE_THRESHOLD = 0.25;
const MAX_RESULTS = 15;
const DEFAULT_LIMIT = 12;
/**
 * Approximate per-rule rendered-size contribution used by the delivery budget's
 * `maxChars` accounting. Mirrors `sanitizeInjectedText`'s value cap so the budget
 * estimate tracks the injected block without importing the renderer.
 */
const RENDER_CHAR_CAP = 500;
/**
 * Nominal relevance assigned to `always`-on and matched `conditional` preferences.
 * Both bypass task scoring (one applies unconditionally, the other because its
 * condition already matched), so they sort ahead of scored `relevant` rules.
 */
const ALWAYS_RELEVANCE = 1;
const CONDITIONAL_RELEVANCE = 1;

// Scoring weights.
const W_DOMAIN = 0.5;
const W_CATEGORY = 0.2;
const W_OVERLAP = 0.35;
const W_REPO = 0.1;
const W_LOCKED = 0.08;
const W_APPROVED = 0.04;

/**
 * An EXPLICIT delivery budget (0.3.0). Effective preferences are computed
 * independently of this budget (conflict/precedence resolution happens first); the
 * budget only bounds how much of the already-resolved set is rendered, and any
 * omission is reported in `RetrievalResult.delivery` — never silent.
 *
 * Both fields default to `null` (unlimited): the CLI and the prompt hook deliver
 * EVERY effective `always` + matched `conditional` rule, which is the 0.3.0 D1 fix
 * (the old hard count caps silently dropped valid matching rules). A caller that
 * genuinely needs to bound injected size can pass a budget; trimming is then
 * deterministic (least-important rules first) and observable.
 */
export interface DeliveryBudget {
  /** Max total characters of rendered rule text across delivered prefs. null = unlimited. */
  maxChars: number | null;
  /** Max number of delivered preferences. null = unlimited. */
  maxPreferences: number | null;
}

/** Unlimited by default: deliver the full effective set (D1 — no arbitrary cap). */
export const DEFAULT_DELIVERY_BUDGET: DeliveryBudget = { maxChars: null, maxPreferences: null };

/**
 * Observable delivery accounting (0.3.0). Distinguishes the four stages the spec
 * requires so omission is never silent: how many matched, how many were effective
 * after conflict/precedence resolution, how many were delivered, and how many were
 * omitted (by the relevance top-K limit vs. by an explicit delivery budget).
 *
 * Invariant: `matched - effective === overridden.length` and
 * `effective - delivered === omittedByRelevanceLimit + omittedByBudget`.
 */
export interface DeliveryDiagnostics {
  /** Applicability-matched, status/scope-eligible candidates entering conflict resolution. */
  matched: number;
  /** Winners after conflict/precedence resolution (the effective preference set). */
  effective: number;
  /** Preferences actually returned. */
  delivered: number;
  /** Effective `relevant` winners dropped because they fell outside the relevance top-K. */
  omittedByRelevanceLimit: number;
  /** Effective preferences dropped by an explicit delivery budget (0 when unlimited). */
  omittedByBudget: number;
  /** The budget in force for this retrieval. */
  budget: DeliveryBudget;
  /** Ids omitted by the delivery budget (explain only; deterministic, least-important first). */
  omittedByBudgetIds?: string[];
}

export interface RetrievedPreference {
  id: string;
  rule: string;
  category: string;
  domain: string | null;
  polarity: string;
  scope: string;
  status: string;
  applicability: string;
  confidence: number;
  relevance: number;
}

export interface RetrievedEnvironment {
  name: string;
  scope: string;
  riskLevel: string;
  available: boolean;
  variableNames: string[];
}

/** Per-conditional evaluation trace, exposed only when `explain` is requested. */
export interface ConditionalEvaluation {
  id: string;
  rule: string;
  scope: string;
  /** True when the condition evaluated true against the runtime context. */
  matched: boolean;
  /** Human-readable reason for the decision (top-level). */
  reason: string;
  condition: Condition | null;
}

/** Normalized runtime context view, exposed only when `explain` is requested. */
export interface RuntimeContextView {
  cwd: string;
  repo: { id: string; name: string; identity: string } | null;
  task: string | null;
  files: string[];
  languages: string[];
  domain: string | null;
}

export interface RetrievalResult {
  repo: { id: string; name: string; identity: string } | null;
  task: string | null;
  preferences: RetrievedPreference[];
  environments: RetrievedEnvironment[];
  /** Preferences dropped because a higher-precedence rule superseded them. */
  overridden: { id: string; rule: string; supersededBy: string }[];
  /** Observable delivery accounting (matched/effective/delivered/omitted). */
  delivery: DeliveryDiagnostics;
  /**
   * NON-authoritative observed decision patterns relevant to this task (0.3.4):
   * compact cross-repo signal EVIDENCE the agent may reason over. Never instructions,
   * never a preference, never promoted. Empty when the task matches no signal domain.
   * Optional on the type so existing result constructors stay valid; the engine always
   * sets it (possibly `[]`).
   */
  observedPatterns?: ObservedPattern[];
  /** The normalized runtime context used for conditional evaluation (explain only). */
  runtimeContext?: RuntimeContextView;
  /** Evaluation result for every conditional candidate (explain only). */
  conditionalEvaluations?: ConditionalEvaluation[];
  /** Signal-evidence selection accounting (explain only). */
  signalEvidence?: {
    consideredDomains: string[];
    delivered: number;
    omittedByBudget: number;
    budget: SignalEvidenceBudget;
  };
}

export interface RetrievalOptions {
  cwd: string;
  task?: string;
  limit?: number;
  /** Include `proposed`/`observed` preferences (default false — only in-effect rules). */
  includeProposed?: boolean;
  /**
   * Whether to stamp `last_used_at` on returned preferences (default true).
   * The prompt hook sets this false so high-frequency retrieval stays read-only
   * and never contends on the write lock.
   */
  track?: boolean;
  // ---- runtime-context inputs for conditional evaluation --------------------
  // These are supplied by the ADAPTER. The Claude prompt hook has only cwd+task,
  // so it leaves files/languages unset (file/language conditions then simply
  // don't match — the documented missing-context rule). The CLI simulator may
  // pass richer, explicit context for debugging.
  /** Explicit file paths active for this turn (normalized to forward slashes). */
  files?: string[];
  /** Explicit languages; override extension inference when given. */
  languages?: string[];
  /** Explicit domain; overrides task-based domain inference when given. */
  domain?: string | null;
  /**
   * Optional explicit delivery budget. Omit (the default) to deliver the FULL
   * effective set — every `always` + matched `conditional` rule, plus the relevance
   * top-K. When supplied, trimming is deterministic and reported in `delivery`.
   */
  budget?: DeliveryBudget;
  /**
   * Optional override of the signal-evidence OUTPUT budget (presentation only). Omit
   * for the default small budget; the simulator/tests pass one for determinism checks.
   */
  signalEvidenceBudget?: SignalEvidenceBudget;
  /**
   * When true, populate `runtimeContext`, `conditionalEvaluations` and `signalEvidence`
   * in the result (used by `ctx test-hook`). Off by default so the hot hook path adds
   * no overhead.
   */
  explain?: boolean;
}

interface Scored {
  pref: Preference;
  relevance: number;
}

/**
 * Pure, deterministic conflict resolver. Operates on preferences (which carry
 * `domain` and `polarity`), independent of any task or scoring, so it is easy to
 * test exhaustively.
 *
 * Rules:
 *  - Exclusive domains (package-manager, database, ui-framework, state-management)
 *    admit ONE winner: the highest-precedence preference wins; the rest are
 *    overridden. This is what makes repo "use npm" beat global "prefer pnpm".
 *  - Non-exclusive domains keep every preference EXCEPT those addressing the same
 *    subject (same subjectKey) — including direct contradictions (same subject,
 *    opposite polarity) — where the highest-precedence one wins.
 *
 * Precedence is the documented hierarchy (see precedence.ts). Input order breaks
 * precedence ties (callers pass most-relevant first).
 */
export function resolveConflicts(prefs: Preference[]): {
  winners: Preference[];
  overridden: { id: string; rule: string; supersededBy: string }[];
} {
  // Stable sort by precedence so the strongest candidate in each group is seen
  // first; equal precedence preserves caller order (relevance).
  const ordered = prefs
    .map((p, i) => ({ p, i }))
    .sort((a, b) => precedenceRank(a.p) - precedenceRank(b.p) || a.i - b.i)
    .map((x) => x.p);

  const winners: Preference[] = [];
  const overridden: { id: string; rule: string; supersededBy: string }[] = [];
  const exclusiveWinner = new Map<string, Preference>();
  const subjectWinner = new Map<string, Preference>();

  for (const p of ordered) {
    if (isExclusiveDomain(p.domain)) {
      const key = p.domain!;
      const held = exclusiveWinner.get(key);
      if (held) {
        overridden.push({ id: p.id, rule: p.rule, supersededBy: held.id });
        continue;
      }
      exclusiveWinner.set(key, p);
      winners.push(p);
    } else {
      const key = `${p.domain ?? ""}|${subjectKey(p.rule)}`;
      const held = subjectWinner.get(key);
      if (held) {
        overridden.push({ id: p.id, rule: p.rule, supersededBy: held.id });
        continue;
      }
      subjectWinner.set(key, p);
      winners.push(p);
    }
  }
  return { winners, overridden };
}

/**
 * The central retrieval pipeline. Adapter-agnostic: any agent integration calls
 * this and gets back a concise, relevance-filtered, conflict-resolved view.
 */
export class RetrievalEngine {
  constructor(
    private readonly db: Database,
    private readonly prefs: PreferenceService,
    private readonly repos: RepoService,
    private readonly envs: EnvironmentService,
    private readonly signals: SignalService,
  ) {}

  retrieve(opts: RetrievalOptions): RetrievalResult {
    const limit = clampLimit(opts.limit ?? DEFAULT_LIMIT);
    const budget = opts.budget ?? DEFAULT_DELIVERY_BUDGET;
    const signalBudget = opts.signalEvidenceBudget ?? DEFAULT_SIGNAL_EVIDENCE_BUDGET;
    // The prompt hook (track === false) must stay a pure read: resolve the repo
    // without registering it, so concurrent hooks never write or contend. Other
    // callers (e.g. `ctx get`) keep registering the repo on first sight.
    const repo =
      opts.track === false ? this.repos.resolveReadOnly(opts.cwd) : this.repos.resolve(opts.cwd);
    const task = opts.task?.trim() || null;

    // The adapter-constructed, normalized runtime context. The condition evaluator
    // reads ONLY this — it never discovers state on its own.
    const runtimeContext: RuntimeContext = buildRuntimeContext({
      cwd: opts.cwd,
      repo,
      task,
      files: opts.files,
      languages: opts.languages,
      domain: opts.domain,
    });

    // Gather + rank + resolve inside a read snapshot so a concurrent commit is
    // observed either fully-before or fully-after — never half-applied.
    const { top, overridden, delivery, conditionalEvaluations, observedPatterns, signalEvidence } = withReadTx(this.db, () => {
      const candidates = this.candidates(repo, opts.includeProposed ?? false);

      // Applicability split. All pools have already passed status + scope filtering
      // in `candidates`, so a rejected rule of any kind is never here.
      const alwaysPool = candidates.filter((p) => p.applicability === "always");
      const conditionalPool = candidates.filter((p) => p.applicability === "conditional");
      const relevantPool = candidates.filter((p) => p.applicability === "relevant");

      // Conditional pool: evaluate each condition deterministically against the
      // runtime context. Only matches are eligible — a conditional NEVER falls back
      // to relevance, and an unevaluable condition does not match.
      const evaluations = conditionalPool.map((pref) => ({
        pref,
        result: pref.condition
          ? evaluateCondition(pref.condition, runtimeContext)
          : { matched: false, reason: "missing condition" },
      }));
      const matchedConditional = evaluations.filter((e) => e.result.matched).map((e) => e.pref);

      // `relevant` rules keep their original behavior: score against the task and
      // drop anything below the threshold. `always` + matched `conditional` bypass
      // scoring entirely.
      const scoredRelevant = this.rank(relevantPool, task);
      const scoredAlways = alwaysPool.map((pref) => ({ pref, relevance: ALWAYS_RELEVANCE }));
      const scoredConditional = matchedConditional.map((pref) => ({
        pref,
        relevance: CONDITIONAL_RELEVANCE,
      }));

      // Resolve conflicts/precedence across the WHOLE set, so an always rule, a
      // matched conditional and a relevant rule competing for the same exclusive
      // decision are reconciled and a repo rule can still override a global one.
      // Conditionals are NOT special-cased in precedence — they compete exactly
      // like any other preference once their condition has matched.
      const combined = [...scoredAlways, ...scoredConditional, ...scoredRelevant];
      const { winners, overridden } = resolveConflicts(combined.map((s) => s.pref));
      const winnerIds = new Set(winners.map((w) => w.id));

      // ---- effective set (D1) ----------------------------------------------
      // Deliver EVERY effective `always` and matched `conditional` rule — the old
      // hard caps (MAX_ALWAYS/MAX_CONDITIONAL = 20) silently dropped valid matching
      // rules and chose the survivors by write-age, which is a correctness bug. The
      // only remaining count limit is the relevance top-K for scored `relevant`
      // rules, which is a genuine relevance ranking (below-threshold rules are
      // already dropped), not an arbitrary cap on matching rules.
      const byPrecedenceAgeId = (a: Scored, b: Scored) =>
        precedenceRank(a.pref) - precedenceRank(b.pref) ||
        a.pref.createdAt.localeCompare(b.pref.createdAt) ||
        a.pref.id.localeCompare(b.pref.id);

      const effectiveAlways = scoredAlways
        .filter((s) => winnerIds.has(s.pref.id))
        .sort(byPrecedenceAgeId);
      const effectiveConditional = scoredConditional
        .filter((s) => winnerIds.has(s.pref.id))
        .sort(byPrecedenceAgeId);
      const effectiveRelevant = scoredRelevant
        .filter((s) => winnerIds.has(s.pref.id))
        .sort(
          (a, b) => b.relevance - a.relevance || precedenceRank(a.pref) - precedenceRank(b.pref),
        );
      const keptRelevant = effectiveRelevant.slice(0, limit);
      const omittedByRelevanceLimit = effectiveRelevant.length - keptRelevant.length;

      // Effective rules are computed INDEPENDENTLY of the render budget. The budget,
      // if any, only trims the already-resolved set, deterministically, from the
      // least-important tail (relevant lowest-relevance first, then conditionals,
      // then always), and records exactly what it dropped.
      const effectiveCount = effectiveAlways.length + effectiveConditional.length + effectiveRelevant.length;
      const matchedCount = scoredAlways.length + scoredConditional.length + scoredRelevant.length;
      const ordered = [...effectiveAlways, ...effectiveConditional, ...keptRelevant];
      const { kept, omittedIds } = applyDeliveryBudget(ordered, budget);

      const delivery: DeliveryDiagnostics = {
        matched: matchedCount,
        effective: effectiveCount,
        delivered: kept.length,
        omittedByRelevanceLimit,
        omittedByBudget: omittedIds.length,
        budget,
        ...(opts.explain ? { omittedByBudgetIds: omittedIds } : {}),
      };

      const conditionalEvaluations: ConditionalEvaluation[] | undefined = opts.explain
        ? evaluations.map((e) => ({
            id: e.pref.id,
            rule: e.pref.rule,
            scope: e.pref.scope,
            matched: e.result.matched,
            reason: e.result.reason,
            condition: e.pref.condition,
          }))
        : undefined;

      // ---- signal evidence (0.3.4) -----------------------------------------
      // Automatic, NON-authoritative cross-repo evidence for the task's decision
      // domains. Gated on the task matching a signal domain, so an unrelated prompt
      // does zero signal work (and no query). Read-only: computed in the SAME read
      // snapshot as the preferences, so it is consistent and always fresh (no cache).
      // Authoritative = the active approved/locked pool (used only to suppress
      // ordinary competing signals, never to mutate anything).
      const taskDomains = taskSignalDomains(runtimeContext);
      let observedPatterns: ObservedPattern[] = [];
      let signalEvidence: RetrievalResult["signalEvidence"] | undefined;
      if (taskDomains.size > 0) {
        const domainEvidence = this.signals.aggregateCanonical({
          domains: [...taskDomains],
          currentRepoId: repo?.id ?? null,
        });
        const authoritative = candidates.filter(
          (p) => p.status === "approved" || p.status === "locked",
        );
        const sel = selectRelevantSignalEvidence(
          runtimeContext,
          domainEvidence,
          authoritative,
          signalBudget,
        );
        observedPatterns = sel.patterns;
        if (opts.explain) {
          signalEvidence = {
            consideredDomains: sel.consideredDomains,
            delivered: sel.patterns.length,
            omittedByBudget: sel.omittedByBudget,
            budget: signalBudget,
          };
        }
      } else if (opts.explain) {
        signalEvidence = {
          consideredDomains: [],
          delivered: 0,
          omittedByBudget: 0,
          budget: signalBudget,
        };
      }

      // Unconditional (always) rules lead, then matched conditionals, then the
      // task-relevant matches in relevance order.
      return { top: kept, overridden, delivery, conditionalEvaluations, observedPatterns, signalEvidence };
    });

    // Best-effort write, outside the read snapshot. Skipped when track === false
    // (the prompt hook) so frequent retrieval never takes the write lock.
    if (opts.track !== false) this.prefs.markUsed(top.map((w) => w.pref.id));

    return {
      repo: repo ? { id: repo.id, name: repo.name, identity: repo.identity } : null,
      task,
      preferences: top.map((w) => ({
        id: w.pref.id,
        rule: w.pref.rule,
        category: w.pref.category,
        domain: w.pref.domain,
        polarity: w.pref.polarity,
        scope: w.pref.scope,
        status: w.pref.status,
        applicability: w.pref.applicability,
        confidence: round(w.pref.confidence),
        relevance: round(w.relevance),
      })),
      environments: this.environments(repo),
      overridden,
      delivery,
      observedPatterns,
      ...(opts.explain
        ? {
            runtimeContext: {
              cwd: runtimeContext.cwd,
              repo: runtimeContext.repo,
              task: runtimeContext.task,
              files: runtimeContext.files,
              languages: [...runtimeContext.languages].sort(),
              domain: runtimeContext.domain,
            },
            conditionalEvaluations: conditionalEvaluations ?? [],
            ...(signalEvidence ? { signalEvidence } : {}),
          }
        : {}),
    };
  }

  private candidates(repo: Repo | null, includeProposed: boolean): Preference[] {
    // D2: eligibility (status + scope/repo) is filtered in SQL. This is identical in
    // result to the previous `prefs.list().filter(...)` full scan, but a many-repo or
    // large store no longer loads and maps rows that cannot possibly match.
    return this.prefs.listCandidates({ repoId: repo?.id ?? null, includeProposed });
  }

  /**
   * Score candidates against the task and drop anything below the relevance
   * threshold. With no task, everything active is kept (ordered later by
   * precedence) so `ctx get` still shows the repo's standing rules.
   */
  private rank(candidates: Preference[], task: string | null): Scored[] {
    if (!task) {
      return candidates.map((pref) => ({ pref, relevance: baseWeight(pref) }));
    }

    const taskTerms = new Set(contentTokens(task));
    const taskDomains = inferDomains(task);
    const idf = this.buildIdf(candidates);

    const denom =
      [...taskTerms].reduce((sum, t) => sum + (idf.get(t) ?? DEFAULT_IDF), 0) || 1;

    const scored: Scored[] = [];
    for (const pref of candidates) {
      const prefTerms = new Set([
        ...subjectTokens(pref.rule),
        ...subjectTokens(pref.category),
      ]);

      let shared = 0;
      for (const t of taskTerms) if (prefTerms.has(t)) shared += idf.get(t) ?? DEFAULT_IDF;
      const overlap = shared / denom;

      const domainMatch = pref.domain != null && taskDomains.has(pref.domain);
      const categoryMatch =
        taskTerms.has(stem(pref.category)) || taskDomains.has(pref.category);

      let score = 0;
      if (domainMatch) score += W_DOMAIN;
      if (categoryMatch) score += W_CATEGORY;
      score += W_OVERLAP * overlap;
      score += baseWeight(pref);

      score = clamp01(score);
      if (score >= RELEVANCE_THRESHOLD) scored.push({ pref, relevance: score });
    }
    return scored;
  }

  /** Document frequency → idf over the candidate set's subject tokens. */
  private buildIdf(candidates: Preference[]): Map<string, number> {
    const df = new Map<string, number>();
    for (const pref of candidates) {
      const terms = new Set([
        ...subjectTokens(pref.rule),
        ...subjectTokens(pref.category),
      ]);
      for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const n = candidates.length || 1;
    const idf = new Map<string, number>();
    for (const [t, d] of df) idf.set(t, Math.log(1 + n / d));
    return idf;
  }

  private environments(repo: Repo | null): RetrievedEnvironment[] {
    return this.envs.listApplicable(repo?.id ?? null).map((e) => ({
      name: e.environment.name,
      scope: e.environment.scope,
      riskLevel: e.environment.riskLevel,
      available: e.available,
      variableNames: e.variableNames,
    }));
  }
}

/**
 * Apply an explicit delivery budget to an already-ordered (most-important-first)
 * scored set. Trimming is a clean suffix cut — once a rule would exceed the budget,
 * it and everything after it is omitted — so the kept set is always the top-priority
 * prefix and the result is fully deterministic. At least one rule is always kept
 * even if it alone exceeds `maxChars`. With an unlimited budget (both null) this is
 * a no-op and allocates nothing.
 */
function applyDeliveryBudget(
  scored: Scored[],
  budget: DeliveryBudget,
): { kept: Scored[]; omittedIds: string[] } {
  if (budget.maxChars == null && budget.maxPreferences == null) return { kept: scored, omittedIds: [] };
  const kept: Scored[] = [];
  const omittedIds: string[] = [];
  let chars = 0;
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i]!;
    const cost = Math.min(s.pref.rule.length, RENDER_CHAR_CAP);
    const overPref = budget.maxPreferences != null && kept.length >= budget.maxPreferences;
    const overChars = budget.maxChars != null && kept.length > 0 && chars + cost > budget.maxChars;
    if (overPref || overChars) {
      for (let j = i; j < scored.length; j++) omittedIds.push(scored[j]!.pref.id);
      break;
    }
    kept.push(s);
    chars += cost;
  }
  return { kept, omittedIds };
}

const DEFAULT_IDF = Math.log(2);

function baseWeight(pref: Preference): number {
  let w = 0;
  if (pref.scope === "repo") w += W_REPO;
  if (pref.status === "locked") w += W_LOCKED;
  else if (pref.status === "approved") w += W_APPROVED;
  return w;
}

function clampLimit(n: number): number {
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(n)));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
