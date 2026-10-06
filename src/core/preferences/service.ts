import type { Database } from "../../storage/sqlite/driver.ts";
import { createHash } from "node:crypto";
import { newId, idMatches } from "../../utils/id.ts";
import { nowIso } from "../../utils/time.ts";
import { NotFoundError, CtxError, ConflictError } from "../../utils/errors.ts";
import { withWriteTx } from "../../storage/sqlite/tx.ts";
import {
  type Evidence,
  type Preference,
  type Scope,
  type Status,
  type Polarity,
  type Applicability,
  ACTIVE_STATUSES,
  RememberInputSchema,
  ProposeInputSchema,
} from "./types.ts";
import { JaccardSimilarity, type Similarity } from "./similarity.ts";
import { inferApplicability, inferPrimaryDomain, polarity as detectPolarity, subjectKey } from "./analysis.ts";
import {
  type Condition,
  conditionFromJson,
  conditionToCanonicalJson,
  compactCondition,
  enforceConditionInvariant,
} from "./conditions.ts";
import { recordEvent, type EventType } from "../events/service.ts";

interface PreferenceRow {
  id: string;
  rule: string;
  normalized: string;
  category: string;
  domain: string | null;
  polarity: string;
  scope: string;
  repo_id: string | null;
  status: string;
  applicability: string;
  condition_json: string | null;
  confidence: number;
  version: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  dedup_key: string | null;
}

interface EvidenceRow {
  id: string;
  preference_id: string;
  source: string;
  repo_id: string | null;
  evidence_text: string;
  agent_id: string | null;
  session_id: string | null;
  created_at: string;
}

function rowToPref(r: PreferenceRow): Preference {
  return {
    id: r.id,
    rule: r.rule,
    category: r.category,
    domain: r.domain,
    polarity: r.polarity as Polarity,
    scope: r.scope as Scope,
    repoId: r.repo_id,
    status: r.status as Status,
    applicability: (r.applicability as Applicability) ?? "relevant",
    condition: conditionFromJson(r.condition_json),
    confidence: r.confidence,
    version: r.version,
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
    agentId: r.agent_id,
    sessionId: r.session_id,
    createdAt: r.created_at,
  };
}

export interface RememberInput {
  rule: string;
  category?: string;
  domain?: string | null;
  scope: Scope;
  repoId?: string | null;
  status?: Status;
  applicability?: Applicability;
  condition?: Condition | null;
  source?: string;
  evidence?: string;
  agentId?: string;
  sessionId?: string;
}

export interface ProposeInput {
  rule: string;
  category?: string;
  domain?: string | null;
  scope: Scope;
  repoId?: string | null;
  evidence: string;
  applicability?: Applicability;
  condition?: Condition | null;
  source?: string;
  agentId?: string;
  sessionId?: string;
}

export interface ProposeResult {
  preference: Preference;
  /** True when evidence was merged into an existing proposal instead of creating one. */
  merged: boolean;
}

/** A portable preference record as it arrives from an export bundle (see transfer.ts). */
export interface ImportRecord {
  rule: string;
  category: string;
  domain: string | null;
  polarity: Polarity;
  scope: Scope;
  status: Status;
  applicability?: Applicability;
  condition?: Condition | null;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  evidence: { source: string; text: string; agentId: string | null; sessionId: string | null }[];
}

export interface TransitionOptions {
  /** The version the caller last observed; a mismatch means concurrent change. */
  expectedVersion?: number;
  /** Override the optimistic-concurrency check (act on current state). */
  force?: boolean;
}

/** Subject-similarity threshold above which same-polarity proposals merge. */
const MERGE_SUBJECT_THRESHOLD = 0.6;
const PROPOSE_START_CONFIDENCE = 0.5;
const PROPOSE_CONFIDENCE_STEP = 0.1;
const PROPOSE_CONFIDENCE_CAP = 0.95;

function hashText(text: string): string {
  const canonical = text.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Canonical dedup key. For `relevant`/`always` rules the format is byte-for-byte
 * the historical `scope|repo|subject|polarity`, so existing data and re-imported
 * old bundles dedup EXACTLY as before. A conditional rule appends its canonical
 * condition, so two conditionals that differ only by condition are distinct, while
 * logically-equal conditions (any key/member ordering) collapse to one key.
 */
function dedupKey(
  scope: Scope,
  repoId: string | null,
  rule: string,
  pol: Polarity,
  condition: Condition | null,
): string {
  const base = `${scope}|${repoId ?? ""}|${subjectKey(rule)}|${pol}`;
  return condition ? `${base}|${conditionToCanonicalJson(condition)}` : base;
}

/** Friendly audit event for a status transition (distinguishes unlock from approve). */
function transitionEventType(from: Status, to: Status): EventType {
  if (to === "approved") return from === "locked" ? "preference.unlocked" : "preference.approved";
  if (to === "rejected") return "preference.rejected";
  if (to === "locked") return "preference.locked";
  return "preference.approved";
}

function confidenceFor(evidenceCount: number): number {
  return Math.min(
    PROPOSE_CONFIDENCE_CAP,
    PROPOSE_START_CONFIDENCE + PROPOSE_CONFIDENCE_STEP * Math.max(0, evidenceCount - 1),
  );
}

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
    return withWriteTx(this.db, () => this.rememberInTx(input));
  }

  /**
   * The transactional CORE of {@link remember}: validates, derives and inserts the
   * preference but assumes the caller ALREADY holds a write transaction (it never
   * opens its own). This lets a decision-aware write persist the preference AND a
   * decision signal in a SINGLE `withWriteTx` so the pair commits/rolls back as one.
   */
  rememberInTx(input: RememberInput): Preference {
    const parsed = RememberInputSchema.parse(input);
    const scope = parsed.scope;
    const repoId = parsed.repoId ?? null;
    this.validateScope(scope, repoId);

    const pol = detectPolarity(parsed.rule);
    const domain = parsed.domain ?? inferPrimaryDomain(parsed.rule, parsed.category);
    // A condition (without an explicit applicability) implies `conditional`;
    // otherwise fall back to the existing relevant/always inference.
    const applicability: Applicability =
      parsed.applicability ?? (parsed.condition ? "conditional" : inferApplicability(parsed.rule));
    const condition = enforceConditionInvariant(applicability, parsed.condition ?? null);
    const status: Status = parsed.status ?? "approved";
    const id = newId();
    const ts = nowIso();

    {
      this.db
        .query(
          `INSERT INTO preferences
             (id, rule, normalized, category, domain, polarity, scope, repo_id, status,
              applicability, condition_json, confidence, version, created_at, updated_at, last_used_at, dedup_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?)`,
        )
        .run(
          id,
          parsed.rule,
          this.sim.normalize(parsed.rule),
          parsed.category,
          domain,
          pol,
          scope,
          repoId,
          status,
          applicability,
          condition ? conditionToCanonicalJson(condition) : null,
          1.0,
          ts,
          ts,
          dedupKey(scope, repoId, parsed.rule, pol, condition),
        );
      this.insertEvidence(id, {
        source: parsed.source ?? "explicit",
        repoId,
        text: parsed.evidence ?? `Explicitly remembered: ${parsed.rule}`,
        agentId: parsed.agentId ?? null,
        sessionId: parsed.sessionId ?? null,
      });
      recordEvent(this.db, {
        type: "preference.remembered",
        preferenceId: id,
        repoId,
        scope,
        summary: parsed.rule,
        detail: {
          status,
          domain,
          polarity: pol,
          applicability,
          ...(condition ? { condition: compactCondition(condition) } : {}),
        },
        agentId: parsed.agentId ?? null,
        sessionId: parsed.sessionId ?? null,
      });
      return this.getById(id)!;
    }
  }

  /**
   * Agent inference. Creates a `proposed` preference, or, when a proposal with
   * the same subject AND the same polarity already exists in the same scope/repo,
   * appends evidence and recomputes confidence instead of duplicating.
   *
   * The whole find-or-create runs in one IMMEDIATE transaction, so two agents
   * proposing the same thing at once produce ONE preference with TWO evidence
   * records rather than a duplicate. Opposite-polarity proposals ("Use Redis" vs
   * "Never use Redis") have different dedup keys and are always kept separate.
   */
  propose(input: ProposeInput): ProposeResult {
    const parsed = ProposeInputSchema.parse(input);
    const scope = parsed.scope;
    const repoId = parsed.repoId ?? null;
    this.validateScope(scope, repoId);

    const pol = detectPolarity(parsed.rule);
    const domain = parsed.domain ?? inferPrimaryDomain(parsed.rule, parsed.category);
    const applicability: Applicability =
      parsed.applicability ?? (parsed.condition ? "conditional" : inferApplicability(parsed.rule));
    const condition = enforceConditionInvariant(applicability, parsed.condition ?? null);
    const key = dedupKey(scope, repoId, parsed.rule, pol, condition);

    return withWriteTx(this.db, () => {
      const existing = this.findSimilarProposal(parsed.rule, scope, repoId, pol, key, condition);
      if (existing) {
        this.insertEvidence(existing.id, {
          source: parsed.source ?? "agent",
          repoId,
          text: parsed.evidence,
          agentId: parsed.agentId ?? null,
          sessionId: parsed.sessionId ?? null,
        });
        const count = this.evidenceCount(existing.id);
        this.db
          .query("UPDATE preferences SET confidence = ?, updated_at = ? WHERE id = ?")
          .run(confidenceFor(count), nowIso(), existing.id);
        recordEvent(this.db, {
          type: "preference.evidence_added",
          preferenceId: existing.id,
          repoId,
          scope,
          summary: existing.rule,
          detail: { merged: true, evidenceCount: count },
          agentId: parsed.agentId ?? null,
          sessionId: parsed.sessionId ?? null,
        });
        return { preference: this.getById(existing.id)!, merged: true };
      }

      const id = newId();
      const ts = nowIso();
      this.db
        .query(
          `INSERT INTO preferences
             (id, rule, normalized, category, domain, polarity, scope, repo_id, status,
              applicability, condition_json, confidence, version, created_at, updated_at, last_used_at, dedup_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, 1, ?, ?, NULL, ?)`,
        )
        .run(
          id,
          parsed.rule,
          this.sim.normalize(parsed.rule),
          parsed.category,
          domain,
          pol,
          scope,
          repoId,
          applicability,
          condition ? conditionToCanonicalJson(condition) : null,
          PROPOSE_START_CONFIDENCE,
          ts,
          ts,
          key,
        );
      this.insertEvidence(id, {
        source: parsed.source ?? "agent",
        repoId,
        text: parsed.evidence,
        agentId: parsed.agentId ?? null,
        sessionId: parsed.sessionId ?? null,
      });
      recordEvent(this.db, {
        type: "preference.proposed",
        preferenceId: id,
        repoId,
        scope,
        summary: parsed.rule,
        detail: {
          domain,
          polarity: pol,
          applicability,
          ...(condition ? { condition: compactCondition(condition) } : {}),
        },
        agentId: parsed.agentId ?? null,
        sessionId: parsed.sessionId ?? null,
      });
      return { preference: this.getById(id)!, merged: false };
    });
  }

  private findSimilarProposal(
    rule: string,
    scope: Scope,
    repoId: string | null,
    pol: Polarity,
    key: string,
    condition: Condition | null,
  ): Preference | null {
    // Fast path: exact canonical key (also what the unique index enforces).
    const exact = this.db
      .query<PreferenceRow, [string]>(
        `SELECT * FROM preferences
         WHERE dedup_key = ? AND status IN ('proposed','observed') LIMIT 1`,
      )
      .get(key);
    if (exact) return rowToPref(exact);

    // Fallback: near-duplicate subject with the SAME polarity (covers legacy
    // rows without a dedup_key and slight phrasing differences). Opposite
    // polarity is never merged. For conditionals, the condition must also be
    // identical (canonical) — two rules that differ by condition are distinct,
    // and a conditional never merges into a relevant/always rule.
    const condCanonical = condition ? conditionToCanonicalJson(condition) : null;
    const candidates = this.db
      .query<PreferenceRow, [string, string]>(
        `SELECT * FROM preferences
         WHERE status IN ('proposed','observed') AND scope = ? AND polarity = ?`,
      )
      .all(scope, pol)
      .filter((r) => (r.repo_id ?? null) === repoId)
      .map(rowToPref)
      .filter((c) => (c.condition ? conditionToCanonicalJson(c.condition) : null) === condCanonical);

    let best: Preference | null = null;
    let bestScore = 0;
    for (const c of candidates) {
      const score = this.sim.score(rule, c.rule);
      if (score >= MERGE_SUBJECT_THRESHOLD && score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * Insert a preference from a portable export record, or merge its evidence into
   * an equivalent preference that already exists (same scope + repo + subject +
   * polarity). This keeps `ctx import` idempotent and prevents duplicate-preference
   * explosion, while preserving genuine contradictions (opposite polarity → a
   * different dedup key → kept separately). Status/confidence/timestamps from the
   * record are preserved on newly-created rows; existing rows are never mutated.
   */
  importOne(rec: ImportRecord, repoId: string | null): { id: string; created: boolean } {
    return withWriteTx(this.db, () => this.importOneTx(rec, repoId));
  }

  /**
   * Import MANY records in a SINGLE write transaction (0.3.0 D5). The per-record
   * behavior is byte-identical to calling `importOne` for each — dedup, evidence
   * merge and conflict preservation all work the same because a SELECT inside a
   * transaction already sees that transaction's own prior INSERTs. The only change
   * is transactional granularity: the old path committed N times (the import
   * bottleneck); this commits once. Rollback is now all-or-nothing, which is a
   * STRONGER guarantee than the old partial-import-on-error behavior — and bundles
   * are fully schema-validated before any insert, so a mid-batch throw is a genuine
   * storage fault where atomic rollback is the safer outcome.
   */
  importMany(
    items: { rec: ImportRecord; repoId: string | null }[],
  ): { id: string; created: boolean }[] {
    if (items.length === 0) return [];
    return withWriteTx(this.db, () => items.map(({ rec, repoId }) => this.importOneTx(rec, repoId)));
  }

  /** The body of a single import, assuming it already runs inside a write transaction. */
  private importOneTx(rec: ImportRecord, repoId: string | null): { id: string; created: boolean } {
    this.validateScope(rec.scope, repoId);
    const applicability: Applicability = rec.applicability ?? "relevant";
    const condition = enforceConditionInvariant(applicability, rec.condition ?? null);
    const key = dedupKey(rec.scope, repoId, rec.rule, rec.polarity, condition);

    const existing = this.db
      .query<PreferenceRow, [string]>("SELECT * FROM preferences WHERE dedup_key = ? LIMIT 1")
      .get(key);
    if (existing) {
      for (const e of rec.evidence) {
        this.insertEvidence(existing.id, {
          source: e.source,
          repoId,
          text: e.text,
          agentId: e.agentId,
          sessionId: e.sessionId,
        });
      }
      return { id: existing.id, created: false };
    }

    const id = newId();
    this.db
      .query(
        `INSERT INTO preferences
           (id, rule, normalized, category, domain, polarity, scope, repo_id, status,
            applicability, condition_json, confidence, version, created_at, updated_at, last_used_at, dedup_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?)`,
      )
      .run(
        id,
        rec.rule,
        this.sim.normalize(rec.rule),
        rec.category,
        rec.domain,
        rec.polarity,
        rec.scope,
        repoId,
        rec.status,
        applicability,
        condition ? conditionToCanonicalJson(condition) : null,
        rec.confidence,
        rec.createdAt,
        rec.updatedAt,
        key,
      );
    for (const e of rec.evidence) {
      this.insertEvidence(id, {
        source: e.source,
        repoId,
        text: e.text,
        agentId: e.agentId,
        sessionId: e.sessionId,
      });
    }
    return { id, created: true };
  }

  // ---- evidence -----------------------------------------------------------

  /**
   * Insert evidence, collapsing exact-duplicate text for the same preference.
   * Duplicate collapse is atomic (unique index + INSERT OR IGNORE) so concurrent
   * identical submissions don't create duplicate rows or lose distinct ones.
   * MUST be called inside a write transaction.
   */
  private insertEvidence(
    preferenceId: string,
    e: { source: string; repoId: string | null; text: string; agentId: string | null; sessionId: string | null },
  ): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO evidence
           (id, preference_id, source, repo_id, evidence_text, agent_id, session_id, text_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        preferenceId,
        e.source,
        e.repoId,
        e.text,
        e.agentId,
        e.sessionId,
        hashText(e.text),
        nowIso(),
      );
  }

  /** Public evidence add (used by tools/tests); atomic, dedup-aware. */
  addEvidence(
    preferenceId: string,
    e: { source: string; repoId: string | null; text: string; agentId?: string | null; sessionId?: string | null },
  ): void {
    withWriteTx(this.db, () => {
      const pref = this.getById(preferenceId);
      if (!pref) throw new NotFoundError(`No preference with id "${preferenceId}".`);
      this.insertEvidence(preferenceId, {
        source: e.source,
        repoId: e.repoId,
        text: e.text,
        agentId: e.agentId ?? null,
        sessionId: e.sessionId ?? null,
      });
      recordEvent(this.db, {
        type: "preference.evidence_added",
        preferenceId,
        repoId: pref.repoId,
        scope: pref.scope,
        summary: pref.rule,
        detail: { source: e.source },
        agentId: e.agentId ?? null,
        sessionId: e.sessionId ?? null,
      });
    });
  }

  evidenceFor(preferenceId: string): Evidence[] {
    return this.db
      .query<EvidenceRow, [string]>(
        "SELECT * FROM evidence WHERE preference_id = ? ORDER BY created_at ASC, id ASC",
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
      .query<PreferenceRow, []>("SELECT * FROM preferences ORDER BY updated_at DESC, id ASC")
      .all();
    let prefs = rows.map(rowToPref);
    if (filter?.status) prefs = prefs.filter((p) => p.status === filter.status);
    if (filter?.scope) prefs = prefs.filter((p) => p.scope === filter.scope);
    if (filter && "repoId" in filter) {
      prefs = prefs.filter((p) => p.repoId === filter.repoId);
    }
    return prefs;
  }

  /**
   * Retrieval candidate set, filtered in SQL (0.3.0 D2). Returns exactly the rows
   * that are even ELIGIBLE to be considered for the given repo context — active
   * status (optionally plus proposed/observed) and visible scope (global, or
   * repo-scoped bound to THIS repo). This pushes the status + scope/repo filter
   * that `RetrievalEngine.candidates()` previously did in JS over a full `SELECT *`
   * down into SQLite, so a many-repo store no longer materializes + maps every
   * other repo's rows on every retrieval.
   *
   * SEMANTICS ARE IDENTICAL to the old `list().filter(...)` path: the WHERE clause
   * mirrors it term-for-term and the `ORDER BY updated_at DESC, id ASC` matches
   * `list()` exactly (same SQLite collation), so the ordered candidate stream — and
   * therefore every downstream scoring/conflict/precedence decision — is unchanged.
   * Only semantically-safe eligibility is pushed down; similarity, conditions,
   * domain matching, conflicts and precedence all remain in JS.
   */
  listCandidates(opts: { repoId?: string | null; includeProposed?: boolean } = {}): Preference[] {
    const statuses: string[] = opts.includeProposed
      ? [...ACTIVE_STATUSES, "proposed", "observed"]
      : [...ACTIVE_STATUSES];
    const ph = statuses.map(() => "?").join(", ");
    const repoId = opts.repoId ?? null;

    // Two TARGETED branches unioned, rather than one `(scope='global' OR …)` query:
    // with a single OR query the planner drives off the low-selectivity `status`
    // index and still scans every repo's rows. The UNION ALL lets each branch pick
    // the selective index — `idx_prefs_scope` for globals, and crucially
    // `idx_prefs_repo (repo_id=?)` for the repo branch, so OTHER repos' rows are
    // never scanned (verified with EXPLAIN QUERY PLAN; uses existing indexes, no
    // schema change). The compound `ORDER BY` reproduces `list()`'s order exactly.
    if (repoId) {
      return this.db
        .query<PreferenceRow, unknown[]>(
          `SELECT * FROM preferences WHERE scope = 'global' AND status IN (${ph})
           UNION ALL
           SELECT * FROM preferences WHERE scope = 'repo' AND repo_id = ? AND status IN (${ph})
           ORDER BY updated_at DESC, id ASC`,
        )
        .all(...statuses, repoId, ...statuses)
        .map(rowToPref);
    }
    // No repo: repo-scoped rows can never match, so only globals are eligible —
    // exactly what the old JS filter returned for a null repo.
    return this.db
      .query<PreferenceRow, unknown[]>(
        `SELECT * FROM preferences WHERE scope = 'global' AND status IN (${ph})
         ORDER BY updated_at DESC, id ASC`,
      )
      .all(...statuses)
      .map(rowToPref);
  }

  pending(): Preference[] {
    return this.list().filter(
      (p) => p.status === "proposed" || p.status === "observed",
    );
  }

  // ---- lifecycle (optimistic concurrency) ---------------------------------

  approve(id: string, opts: TransitionOptions = {}): Preference {
    return this.transition(id, "approved", opts);
  }

  reject(id: string, opts: TransitionOptions = {}): Preference {
    return this.transition(id, "rejected", opts);
  }

  lock(id: string, opts: TransitionOptions = {}): Preference {
    return this.transition(id, "locked", opts);
  }

  /**
   * Compare-and-swap state transition. If the caller passed the version it last
   * observed and the row has since changed, the transition is refused with a
   * ConflictError rather than silently clobbering the newer state. `force`
   * bypasses the check and acts on whatever the current state is.
   */
  private transition(id: string, target: Status, opts: TransitionOptions): Preference {
    return withWriteTx(this.db, () => {
      const current = this.getById(id);
      if (!current) throw new NotFoundError(`No preference with id "${id}".`);
      const expected = opts.force ? current.version : opts.expectedVersion ?? current.version;
      const res = this.db
        .query(
          "UPDATE preferences SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
        )
        .run(target, nowIso(), id, expected);
      if ((res.changes ?? 0) === 0) {
        const now = this.getById(id)!;
        throw new ConflictError(
          `Preference ${id.slice(0, 8)} changed concurrently (now "${now.status}", v${now.version}); ` +
            `not applying "${target}". Re-run to act on the current state (or use --force).`,
        );
      }
      recordEvent(this.db, {
        type: transitionEventType(current.status, target),
        preferenceId: id,
        repoId: current.repoId,
        scope: current.scope,
        summary: current.rule,
        detail: { from: current.status, to: target },
      });
      return this.getById(id)!;
    });
  }

  /** Permanently delete a preference and its evidence (cascade), with CAS. */
  forget(id: string, opts: TransitionOptions = {}): void {
    withWriteTx(this.db, () => {
      const current = this.getById(id);
      if (!current) throw new NotFoundError(`No preference with id "${id}".`);
      const expected = opts.force ? current.version : opts.expectedVersion ?? current.version;
      const res = this.db
        .query("DELETE FROM preferences WHERE id = ? AND version = ?")
        .run(id, expected);
      if ((res.changes ?? 0) === 0) {
        const now = this.getById(id);
        throw new ConflictError(
          `Preference ${id.slice(0, 8)} changed concurrently${now ? ` (now "${now.status}", v${now.version}")` : ""}; ` +
            `not deleting. Re-run (or use --force).`,
        );
      }
      recordEvent(this.db, {
        type: "preference.forgotten",
        preferenceId: id,
        repoId: current.repoId,
        scope: current.scope,
        summary: current.rule,
        detail: { status: current.status },
      });
    });
  }

  /**
   * Best-effort "last used" stamp on retrieval. Never throws: a read must not
   * fail just because a writer holds the lock, so a BUSY here is swallowed.
   */
  markUsed(ids: string[]): void {
    if (ids.length === 0) return;
    const ts = nowIso();
    try {
      withWriteTx(this.db, () => {
        const stmt = this.db.query(
          "UPDATE preferences SET last_used_at = ? WHERE id = ?",
        );
        for (const id of ids) stmt.run(ts, id);
      });
    } catch {
      /* last-used tracking is best-effort; ignore contention */
    }
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
