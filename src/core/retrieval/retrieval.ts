import type { Database } from "../../storage/sqlite/driver.ts";
import type { Preference } from "../preferences/types.ts";
import { ACTIVE_STATUSES } from "../preferences/types.ts";
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

/** Minimum relevance to be returned. Below this, a preference is dropped. */
const RELEVANCE_THRESHOLD = 0.25;
const MAX_RESULTS = 15;
const DEFAULT_LIMIT = 12;

// Scoring weights.
const W_DOMAIN = 0.5;
const W_CATEGORY = 0.2;
const W_OVERLAP = 0.35;
const W_REPO = 0.1;
const W_LOCKED = 0.08;
const W_APPROVED = 0.04;

export interface RetrievedPreference {
  id: string;
  rule: string;
  category: string;
  domain: string | null;
  polarity: string;
  scope: string;
  status: string;
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

export interface RetrievalResult {
  repo: { id: string; name: string; identity: string } | null;
  task: string | null;
  preferences: RetrievedPreference[];
  environments: RetrievedEnvironment[];
  /** Preferences dropped because a higher-precedence rule superseded them. */
  overridden: { id: string; rule: string; supersededBy: string }[];
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
  ) {}

  retrieve(opts: RetrievalOptions): RetrievalResult {
    const limit = clampLimit(opts.limit ?? DEFAULT_LIMIT);
    // The prompt hook (track === false) must stay a pure read: resolve the repo
    // without registering it, so concurrent hooks never write or contend. Other
    // callers (e.g. `ctx get`) keep registering the repo on first sight.
    const repo =
      opts.track === false ? this.repos.resolveReadOnly(opts.cwd) : this.repos.resolve(opts.cwd);
    const task = opts.task?.trim() || null;

    // Gather + rank + resolve inside a read snapshot so a concurrent commit is
    // observed either fully-before or fully-after — never half-applied.
    const { top, overridden } = withReadTx(this.db, () => {
      const candidates = this.candidates(repo, opts.includeProposed ?? false);
      const scored = this.rank(candidates, task);
      const { winners, overridden } = resolveConflicts(scored.map((s) => s.pref));
      const winnerIds = new Set(winners.map((w) => w.id));
      const kept = scored
        .filter((s) => winnerIds.has(s.pref.id))
        .sort(
          (a, b) => b.relevance - a.relevance || precedenceRank(a.pref) - precedenceRank(b.pref),
        )
        .slice(0, limit);
      return { top: kept, overridden };
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
        confidence: round(w.pref.confidence),
        relevance: round(w.relevance),
      })),
      environments: this.environments(repo),
      overridden,
    };
  }

  private candidates(repo: Repo | null, includeProposed: boolean): Preference[] {
    const statuses: string[] = includeProposed
      ? [...ACTIVE_STATUSES, "proposed", "observed"]
      : [...ACTIVE_STATUSES];
    return this.prefs.list().filter((p) => {
      if (!statuses.includes(p.status)) return false;
      if (p.scope === "global") return true;
      if (p.scope === "repo") return repo != null && p.repoId === repo.id;
      return false;
    });
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
