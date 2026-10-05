import type { Database } from "../../storage/sqlite/driver.ts";
import { newId } from "../../utils/id.ts";
import { nowIso } from "../../utils/time.ts";
import { CtxError } from "../../utils/errors.ts";
import { withWriteTx } from "../../storage/sqlite/tx.ts";

/**
 * The SIGNALS layer (0.3.2): a lightweight, local-only ledger of developer
 * DECISIONS, kept strictly separate from preferences.
 *
 *   Preferences  — authoritative behavioral instructions (ctx remember).
 *   Proposals    — inferred candidate preferences awaiting review (ctx propose).
 *   Signals      — NON-authoritative evidence of a choice the developer made
 *                  (domain=backend, choice=supabase). Never injected as an
 *                  instruction; the agent reasons over aggregated signal evidence
 *                  and may, by its OWN judgment, raise a `ctx propose`.
 *
 * Invariants:
 *  - A signal NEVER becomes a preference automatically. There is NO count
 *    threshold anywhere in this file; promotion is always an LLM judgment.
 *  - Evidence is compact: only (domain, choice) + provenance. No transcripts, no
 *    source code, no secrets.
 *  - Genuinely separate evidence (different repo / session / day) is preserved;
 *    only same-immediate-context repeats are de-duplicated.
 */

const MAX_DOMAIN_LEN = 64;
const MAX_CHOICE_LEN = 80;
const MAX_CONTEXT_LEN = 200;

export interface Signal {
  id: string;
  domain: string;
  choice: string;
  choiceRaw: string;
  repoId: string | null;
  sessionId: string | null;
  agentId: string | null;
  context: string | null;
  createdAt: string;
}

interface SignalRow {
  id: string;
  domain: string;
  choice: string;
  choice_raw: string;
  repo_id: string | null;
  session_id: string | null;
  agent_id: string | null;
  context: string | null;
  created_at: string;
}

function rowToSignal(r: SignalRow): Signal {
  return {
    id: r.id,
    domain: r.domain,
    choice: r.choice,
    choiceRaw: r.choice_raw,
    repoId: r.repo_id,
    sessionId: r.session_id,
    agentId: r.agent_id,
    context: r.context,
    createdAt: r.created_at,
  };
}

/**
 * Normalize a decision domain to a stable kebab token: lowercased, spaces/underscores
 * → `-`, punctuation dropped. "Package Manager" → "package-manager". Deterministic and
 * dependency-free — NOT an embedding. This is only canonicalization, not semantics.
 */
export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Normalize a choice to a canonical string: lowercased, whitespace collapsed. */
export function normalizeChoice(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface AddSignalInput {
  domain: string;
  choice: string;
  repoId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  context?: string | null;
}

/** One choice observed in a domain, with aggregate evidence (never a verdict). */
export interface ChoiceEvidence {
  choice: string;
  /** A human-friendly label (the most recent raw spelling seen). */
  label: string;
  /** Number of distinct-context observations (post same-context dedup). */
  observations: number;
  /** How many DISTINCT repositories this choice was seen in (strongest signal). */
  distinctRepos: number;
  /** How many distinct sessions (when the host supplied a session id). */
  distinctSessions: number;
  firstSeen: string;
  lastSeen: string;
}

/** Aggregated, non-authoritative evidence for one decision domain. */
export interface DomainEvidence {
  domain: string;
  /** Choices seen in this domain, strongest evidence first. Minority choices are KEPT. */
  choices: ChoiceEvidence[];
  /** True when more than one distinct choice has been observed (unresolved). */
  contradictory: boolean;
}

export class SignalService {
  constructor(private readonly db: Database) {}

  /**
   * Record a decision signal. Conservative same-context dedup: a repeat of the SAME
   * (domain, choice, repo, session) on the SAME day does not create a second row — so
   * local spam collapses — but a different repo, session, or day is preserved as
   * genuinely separate evidence. Returns the row (new or the deduped existing one).
   */
  add(input: AddSignalInput): { signal: Signal; created: boolean } {
    const domain = normalizeDomain(input.domain);
    const choice = normalizeChoice(input.choice);
    if (!domain) throw new CtxError("A signal requires a non-empty --domain (e.g. backend, package-manager).");
    if (!choice) throw new CtxError("A signal requires a non-empty --choice (e.g. supabase, bun).");
    if (domain.length > MAX_DOMAIN_LEN) throw new CtxError(`--domain too long (max ${MAX_DOMAIN_LEN}).`);
    if (choice.length > MAX_CHOICE_LEN) throw new CtxError(`--choice too long (max ${MAX_CHOICE_LEN}).`);

    const repoId = input.repoId ?? null;
    const sessionId = input.sessionId ?? null;
    const agentId = input.agentId ?? null;
    const context = input.context ? input.context.trim().slice(0, MAX_CONTEXT_LEN) : null;
    const choiceRaw = input.choice.trim().slice(0, MAX_CHOICE_LEN);
    const ts = nowIso();
    const day = ts.slice(0, 10);

    return withWriteTx(this.db, () => {
      // Same immediate context = same (domain, choice, repo, session) on the same day.
      const existing = this.db
        .query<SignalRow, [string, string, string | null, string | null, string]>(
          `SELECT * FROM decision_signals
           WHERE domain = ? AND choice = ? AND repo_id IS ? AND session_id IS ?
             AND substr(created_at, 1, 10) = ?
           LIMIT 1`,
        )
        .get(domain, choice, repoId, sessionId, day);
      if (existing) return { signal: rowToSignal(existing), created: false };

      const id = newId();
      this.db
        .query(
          `INSERT INTO decision_signals
             (id, domain, choice, choice_raw, repo_id, session_id, agent_id, context, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, domain, choice, choiceRaw, repoId, sessionId, agentId, context, ts);
      return { signal: this.getById(id)!, created: true };
    });
  }

  getById(id: string): Signal | null {
    const row = this.db
      .query<SignalRow, [string]>("SELECT * FROM decision_signals WHERE id = ?")
      .get(id);
    return row ? rowToSignal(row) : null;
  }

  /** Raw signals, newest first, optionally filtered by (normalized) domain/choice. */
  list(filter: { domain?: string; choice?: string; limit?: number } = {}): Signal[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.domain) {
      clauses.push("domain = ?");
      params.push(normalizeDomain(filter.domain));
    }
    if (filter.choice) {
      clauses.push("choice = ?");
      params.push(normalizeChoice(filter.choice));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit != null ? Math.max(1, Math.floor(filter.limit)) : null;
    const limitSql = limit != null ? "LIMIT ?" : "";
    if (limit != null) params.push(limit);
    return this.db
      .query<SignalRow, (string | number)[]>(
        `SELECT * FROM decision_signals ${where} ORDER BY created_at DESC, rowid DESC ${limitSql}`,
      )
      .all(...params)
      .map(rowToSignal);
  }

  /**
   * Aggregate evidence per domain. Cross-repo / cross-session breadth is surfaced
   * EXPLICITLY (distinctRepos/distinctSessions) because breadth is far stronger
   * evidence than a raw count: one choice in five repos beats eight in one. Minority
   * and contradictory choices are never hidden — the agent decides what, if anything,
   * the evidence warrants. This returns FACTS, never a verdict.
   */
  aggregate(domain?: string): DomainEvidence[] {
    const signals = this.list(domain ? { domain } : {});
    const byDomain = new Map<string, Signal[]>();
    for (const s of signals) {
      const arr = byDomain.get(s.domain) ?? [];
      arr.push(s);
      byDomain.set(s.domain, arr);
    }

    const out: DomainEvidence[] = [];
    for (const [dom, rows] of byDomain) {
      const byChoice = new Map<string, Signal[]>();
      for (const s of rows) {
        const arr = byChoice.get(s.choice) ?? [];
        arr.push(s);
        byChoice.set(s.choice, arr);
      }
      const choices: ChoiceEvidence[] = [];
      for (const [ch, chRows] of byChoice) {
        const repos = new Set(chRows.filter((r) => r.repoId).map((r) => r.repoId!));
        const sessions = new Set(chRows.filter((r) => r.sessionId).map((r) => r.sessionId!));
        const sorted = [...chRows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        choices.push({
          choice: ch,
          label: chRows[0]!.choiceRaw, // newest-first list → most recent spelling
          observations: chRows.length,
          distinctRepos: repos.size,
          distinctSessions: sessions.size,
          firstSeen: sorted[0]!.createdAt,
          lastSeen: sorted[sorted.length - 1]!.createdAt,
        });
      }
      // Strongest evidence first: distinct repos, then observations, then recency.
      choices.sort(
        (a, b) =>
          b.distinctRepos - a.distinctRepos ||
          b.observations - a.observations ||
          b.lastSeen.localeCompare(a.lastSeen) ||
          a.choice.localeCompare(b.choice),
      );
      out.push({ domain: dom, choices, contradictory: choices.length > 1 });
    }
    out.sort((a, b) => a.domain.localeCompare(b.domain));
    return out;
  }

  /** Delete one signal by id. Returns true if a row was removed. */
  forget(id: string): boolean {
    return withWriteTx(this.db, () => {
      const res = this.db.query("DELETE FROM decision_signals WHERE id = ?").run(id);
      return (res.changes ?? 0) > 0;
    });
  }

  /** Clear all signals, or just one domain's. Returns how many were removed. */
  clear(domain?: string): number {
    return withWriteTx(this.db, () => {
      if (domain) {
        const res = this.db
          .query("DELETE FROM decision_signals WHERE domain = ?")
          .run(normalizeDomain(domain));
        return res.changes ?? 0;
      }
      const res = this.db.query("DELETE FROM decision_signals").run();
      return res.changes ?? 0;
    });
  }

  count(): number {
    const row = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM decision_signals").get();
    return row?.n ?? 0;
  }
}
