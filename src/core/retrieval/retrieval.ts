import type { Preference } from "../preferences/types.ts";
import { ACTIVE_STATUSES } from "../preferences/types.ts";
import type { PreferenceService } from "../preferences/service.ts";
import type { RepoService, Repo } from "../repos/repo.ts";
import type { EnvironmentService } from "../environments/service.ts";
import {
  coverageScore,
  JaccardSimilarity,
  type Similarity,
} from "../preferences/similarity.ts";
import { precedenceRank, outranks } from "./precedence.ts";

/** A conflict resolution threshold: two rules above this are "the same topic". */
const CONFLICT_THRESHOLD = 0.55;

export interface RetrievedPreference {
  id: string;
  rule: string;
  category: string;
  scope: string;
  status: string;
  confidence: number;
  /** Relevance to the supplied task, in [0, 1]. */
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
}

/**
 * The central retrieval pipeline. Adapter-agnostic: any agent integration calls
 * this and gets back a concise, ranked, conflict-resolved view of the developer's
 * context for the current repository and task.
 */
export class RetrievalEngine {
  private readonly sim: Similarity;

  constructor(
    private readonly prefs: PreferenceService,
    private readonly repos: RepoService,
    private readonly envs: EnvironmentService,
    sim: Similarity = new JaccardSimilarity(),
  ) {
    this.sim = sim;
  }

  retrieve(opts: RetrievalOptions): RetrievalResult {
    const limit = clampLimit(opts.limit ?? 12);
    const repo = this.repos.resolve(opts.cwd);
    const task = opts.task?.trim() || null;

    // 1-2. Candidate set: global preferences + this repo's preferences.
    const candidates = this.candidates(repo, opts.includeProposed ?? false);

    // 3. Rank by relevance to the task.
    const scored = candidates
      .map((p) => ({ pref: p, relevance: this.relevance(p, task) }))
      .sort((a, b) => b.relevance - a.relevance || precedenceRank(a.pref) - precedenceRank(b.pref));

    // 4. Resolve conflicts: among near-duplicate rules, keep the highest-precedence.
    const { winners, overridden } = this.resolveConflicts(scored);

    // 5. Concise output: keep the most relevant, roughly 5–15.
    const top = winners.slice(0, limit);

    this.prefs.markUsed(top.map((w) => w.pref.id));

    return {
      repo: repo ? { id: repo.id, name: repo.name, identity: repo.identity } : null,
      task,
      preferences: top.map((w) => ({
        id: w.pref.id,
        rule: w.pref.rule,
        category: w.pref.category,
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
    const statuses = includeProposed
      ? [...ACTIVE_STATUSES, "proposed", "observed"]
      : ACTIVE_STATUSES;

    const all = this.prefs.list();
    return all.filter((p) => {
      if (!statuses.includes(p.status)) return false;
      if (p.scope === "global") return true;
      if (p.scope === "repo") return repo != null && p.repoId === repo.id;
      return false;
    });
  }

  /**
   * Relevance blends task/rule text overlap with a small base weight from status
   * and confidence, so that even a preference with no lexical overlap still
   * surfaces when there is room (and authoritative rules aren't buried).
   */
  private relevance(p: Preference, task: string | null): number {
    const base = 0.15 * p.confidence + statusWeight(p.status);
    if (!task) return clamp01(base);
    const haystack = `${p.rule} ${p.category}`;
    const textScore = coverageScore(task, haystack, this.sim);
    return clamp01(0.75 * textScore + base);
  }

  private resolveConflicts(
    scored: { pref: Preference; relevance: number }[],
  ): {
    winners: { pref: Preference; relevance: number }[];
    overridden: { id: string; rule: string; supersededBy: string }[];
  } {
    const winners: { pref: Preference; relevance: number }[] = [];
    const overridden: { id: string; rule: string; supersededBy: string }[] = [];

    for (const item of scored) {
      const clashIndex = winners.findIndex(
        (w) =>
          w.pref.category === item.pref.category &&
          this.sim.score(w.pref.rule, item.pref.rule) >= CONFLICT_THRESHOLD,
      );
      if (clashIndex === -1) {
        winners.push(item);
        continue;
      }
      const kept = winners[clashIndex]!;
      if (outranks(item.pref, kept.pref)) {
        winners[clashIndex] = item;
        overridden.push({
          id: kept.pref.id,
          rule: kept.pref.rule,
          supersededBy: item.pref.id,
        });
      } else {
        overridden.push({
          id: item.pref.id,
          rule: item.pref.rule,
          supersededBy: kept.pref.id,
        });
      }
    }
    return { winners, overridden };
  }

  private environments(repo: Repo | null): RetrievedEnvironment[] {
    const list = this.envs.listApplicable(repo?.id ?? null);
    return list.map((e) => ({
      name: e.environment.name,
      scope: e.environment.scope,
      riskLevel: e.environment.riskLevel,
      available: e.available,
      variableNames: e.variableNames,
    }));
  }
}

function statusWeight(status: string): number {
  switch (status) {
    case "locked":
      return 0.15;
    case "approved":
      return 0.1;
    default:
      return 0;
  }
}

function clampLimit(n: number): number {
  return Math.max(1, Math.min(15, Math.floor(n)));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
