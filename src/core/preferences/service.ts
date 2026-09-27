import type { Database } from "bun:sqlite";
import { newId, idMatches } from "../../utils/id.ts";
import { nowIso } from "../../utils/time.ts";
import { NotFoundError, CtxError } from "../../utils/errors.ts";
import {
  type Evidence,
  type Preference,
  type Scope,
  type Status,
} from "./types.ts";
import { JaccardSimilarity, type Similarity } from "./similarity.ts";

interface PreferenceRow {
  id: string;
  rule: string;
  normalized: string;
  category: string;
  scope: string;
  repo_id: string | null;
  status: string;
  confidence: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

interface EvidenceRow {
  id: string;
  preference_id: string;
  source: string;
  repo_id: string | null;
  evidence_text: string;
  created_at: string;
}

function rowToPref(r: PreferenceRow): Preference {
  return {
    id: r.id,
    rule: r.rule,
    category: r.category,
    scope: r.scope as Scope,
    repoId: r.repo_id,
    status: r.status as Status,
    confidence: r.confidence,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastUsedAt: r.last_used_at,
  };
}

function rowToEvidence(r: EvidenceRow): Evidence {
  return {
    id: r.id,
    preferenceId: r.preference_id,
    source: r.source,
    repoId: r.repo_id,
    evidenceText: r.evidence_text,
    createdAt: r.created_at,
  };
}

export interface RememberInput {
  rule: string;
  category: string;
  scope: Scope;
  repoId?: string | null;
  /** Override the default `approved` status (e.g. `locked`). */
  status?: Status;
  source?: string;
  evidence?: string;
}

export interface ProposeInput {
  rule: string;
  category: string;
  scope: Scope;
  repoId?: string | null;
  evidence: string;
  source?: string;
}

export interface ProposeResult {
  preference: Preference;
  /** True when evidence was merged into an existing proposal instead of creating one. */
  merged: boolean;
}

/** Similarity threshold above which a proposal is merged into an existing one. */
const MERGE_THRESHOLD = 0.6;
const PROPOSE_START_CONFIDENCE = 0.5;
const PROPOSE_CONFIDENCE_STEP = 0.1;
const PROPOSE_CONFIDENCE_CAP = 0.95;

export class PreferenceService {
  private readonly sim: Similarity;

  constructor(
    private readonly db: Database,
    sim: Similarity = new JaccardSimilarity(),
  ) {
    this.sim = sim;
  }

  // ---- creation -----------------------------------------------------------

  /** Explicit developer instruction. Creates an in-effect (approved) preference. */
  remember(input: RememberInput): Preference {
    this.validateScope(input.scope, input.repoId ?? null);
    const ts = nowIso();
    const id = newId();
    const status: Status = input.status ?? "approved";
    this.db
      .query(
        `INSERT INTO preferences
           (id, rule, normalized, category, scope, repo_id, status, confidence, created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.rule,
        this.sim.normalize(input.rule),
        input.category,
        input.scope,
        input.repoId ?? null,
        status,
        1.0,
        ts,
        ts,
      );
    this.addEvidence(id, {
      source: input.source ?? "explicit",
      repoId: input.repoId ?? null,
      text: input.evidence ?? `Explicitly remembered: ${input.rule}`,
    });
    return this.getById(id)!;
  }

  /**
   * Agent inference. Creates a `proposed` preference, or, when a sufficiently
   * similar proposal already exists in the same scope/repo, appends evidence and
   * nudges its confidence up instead of creating a duplicate.
   */
  propose(input: ProposeInput): ProposeResult {
    this.validateScope(input.scope, input.repoId ?? null);
    const existing = this.findSimilarProposal(
      input.rule,
      input.scope,
      input.repoId ?? null,
    );

    if (existing) {
      this.addEvidence(existing.id, {
        source: input.source ?? "agent",
        repoId: input.repoId ?? null,
        text: input.evidence,
      });
      const newConfidence = Math.min(
        PROPOSE_CONFIDENCE_CAP,
        existing.confidence + PROPOSE_CONFIDENCE_STEP,
      );
      this.db
        .query("UPDATE preferences SET confidence = ?, updated_at = ? WHERE id = ?")
        .run(newConfidence, nowIso(), existing.id);
      return { preference: this.getById(existing.id)!, merged: true };
    }

    const ts = nowIso();
    const id = newId();
    this.db
      .query(
        `INSERT INTO preferences
           (id, rule, normalized, category, scope, repo_id, status, confidence, created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.rule,
        this.sim.normalize(input.rule),
        input.category,
        input.scope,
        input.repoId ?? null,
        PROPOSE_START_CONFIDENCE,
        ts,
        ts,
      );
    this.addEvidence(id, {
      source: input.source ?? "agent",
      repoId: input.repoId ?? null,
      text: input.evidence,
    });
    return { preference: this.getById(id)!, merged: false };
  }

  private findSimilarProposal(
    rule: string,
    scope: Scope,
    repoId: string | null,
  ): Preference | null {
    const candidates = this.db
      .query<PreferenceRow, [string]>(
        `SELECT * FROM preferences
         WHERE status IN ('proposed','observed') AND scope = ?`,
      )
      .all(scope)
      .filter((r) => (r.repo_id ?? null) === repoId)
      .map(rowToPref);

    let best: Preference | null = null;
    let bestScore = 0;
    for (const c of candidates) {
      const score = this.sim.score(rule, c.rule);
      if (score >= MERGE_THRESHOLD && score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    return best;
  }

  // ---- evidence -----------------------------------------------------------

  addEvidence(
    preferenceId: string,
    e: { source: string; repoId: string | null; text: string },
  ): Evidence {
    const id = newId();
    const ts = nowIso();
    this.db
      .query(
        `INSERT INTO evidence (id, preference_id, source, repo_id, evidence_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, preferenceId, e.source, e.repoId, e.text, ts);
    return {
      id,
      preferenceId,
      source: e.source,
      repoId: e.repoId,
      evidenceText: e.text,
      createdAt: ts,
    };
  }

  evidenceFor(preferenceId: string): Evidence[] {
    return this.db
      .query<EvidenceRow, [string]>(
        "SELECT * FROM evidence WHERE preference_id = ? ORDER BY created_at ASC",
      )
      .all(preferenceId)
      .map(rowToEvidence);
  }

  evidenceCount(preferenceId: string): number {
    const row = this.db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM evidence WHERE preference_id = ?",
      )
      .get(preferenceId);
    return row?.c ?? 0;
  }

  // ---- reads --------------------------------------------------------------

  getById(id: string): Preference | null {
    const row = this.db
      .query<PreferenceRow, [string]>("SELECT * FROM preferences WHERE id = ?")
      .get(id);
    return row ? rowToPref(row) : null;
  }

  /** Resolve a full id or unique id prefix to a preference. */
  resolveRef(fragment: string): Preference {
    const direct = this.getById(fragment);
    if (direct) return direct;
    const matches = this.list().filter((p) => idMatches(p.id, fragment));
    if (matches.length === 0) {
      throw new NotFoundError(`No preference matching id "${fragment}".`);
    }
    if (matches.length > 1) {
      throw new CtxError(
        `Ambiguous id "${fragment}" matches ${matches.length} preferences; use more characters.`,
      );
    }
    return matches[0]!;
  }

  list(filter?: { status?: Status; scope?: Scope; repoId?: string | null }): Preference[] {
    const rows = this.db
      .query<PreferenceRow, []>("SELECT * FROM preferences ORDER BY updated_at DESC")
      .all();
    let prefs = rows.map(rowToPref);
    if (filter?.status) prefs = prefs.filter((p) => p.status === filter.status);
    if (filter?.scope) prefs = prefs.filter((p) => p.scope === filter.scope);
    if (filter && "repoId" in filter) {
      prefs = prefs.filter((p) => p.repoId === filter.repoId);
    }
    return prefs;
  }

  pending(): Preference[] {
    return this.list().filter(
      (p) => p.status === "proposed" || p.status === "observed",
    );
  }

  // ---- lifecycle ----------------------------------------------------------

  approve(id: string): Preference {
    return this.setStatus(id, "approved");
  }

  reject(id: string): Preference {
    return this.setStatus(id, "rejected");
  }

  lock(id: string): Preference {
    return this.setStatus(id, "locked");
  }

  private setStatus(id: string, status: Status): Preference {
    const pref = this.getById(id);
    if (!pref) throw new NotFoundError(`No preference with id "${id}".`);
    this.db
      .query("UPDATE preferences SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), id);
    return this.getById(id)!;
  }

  /** Permanently delete a preference and its evidence (cascade). */
  forget(id: string): void {
    const pref = this.getById(id);
    if (!pref) throw new NotFoundError(`No preference with id "${id}".`);
    this.db.query("DELETE FROM preferences WHERE id = ?").run(id);
  }

  markUsed(ids: string[]): void {
    if (ids.length === 0) return;
    const ts = nowIso();
    const stmt = this.db.query(
      "UPDATE preferences SET last_used_at = ? WHERE id = ?",
    );
    const tx = this.db.transaction(() => {
      for (const id of ids) stmt.run(ts, id);
    });
    tx();
  }

  private validateScope(scope: Scope, repoId: string | null): void {
    if (scope === "repo" && !repoId) {
      throw new CtxError(
        "Repo-scoped preferences require a repository. Run inside a git repo or pass --scope global.",
      );
    }
    if (scope === "global" && repoId) {
      throw new CtxError("Global preferences must not be bound to a repo.");
    }
  }
}
