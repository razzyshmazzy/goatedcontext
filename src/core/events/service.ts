import type { Database } from "bun:sqlite";
import { newId } from "../../utils/id.ts";
import { nowIso } from "../../utils/time.ts";

/**
 * Local, append-only audit log of preference/environment changes.
 *
 * Events are recorded inside the same write transaction as the change they
 * describe (see the preference/environment services), so an event is never
 * observed without its change and vice-versa. The log is purely local and
 * compact: no secret values, ever — only rule text, names and safe metadata.
 */

export type EventType =
  | "preference.remembered"
  | "preference.proposed"
  | "preference.evidence_added"
  | "preference.approved"
  | "preference.rejected"
  | "preference.locked"
  | "preference.unlocked"
  | "preference.forgotten"
  | "environment.created"
  | "environment.removed";

export interface CtxEvent {
  id: string;
  type: EventType | string;
  preferenceId: string | null;
  repoId: string | null;
  scope: string | null;
  /** Short human summary (rule text or environment name). Never a secret value. */
  summary: string;
  /** Safe structured metadata (e.g. from/to status). Never a secret value. */
  detail: Record<string, unknown> | null;
  agentId: string | null;
  sessionId: string | null;
  createdAt: string;
}

export interface RecordEventInput {
  type: EventType;
  preferenceId?: string | null;
  repoId?: string | null;
  scope?: string | null;
  summary: string;
  detail?: Record<string, unknown> | null;
  agentId?: string | null;
  sessionId?: string | null;
}

interface EventRow {
  id: string;
  type: string;
  preference_id: string | null;
  repo_id: string | null;
  scope: string | null;
  summary: string;
  detail: string | null;
  agent_id: string | null;
  session_id: string | null;
  created_at: string;
}

function rowToEvent(r: EventRow): CtxEvent {
  let detail: Record<string, unknown> | null = null;
  if (r.detail) {
    try {
      detail = JSON.parse(r.detail);
    } catch {
      detail = null;
    }
  }
  return {
    id: r.id,
    type: r.type,
    preferenceId: r.preference_id,
    repoId: r.repo_id,
    scope: r.scope,
    summary: r.summary,
    detail,
    agentId: r.agent_id,
    sessionId: r.session_id,
    createdAt: r.created_at,
  };
}

/**
 * Insert one audit event. MUST be called inside an active write transaction when
 * it should be atomic with a data change (the preference service does this). It
 * is a plain INSERT so it participates in the caller's transaction.
 */
export function recordEvent(db: Database, e: RecordEventInput): void {
  db.query(
    `INSERT INTO events
       (id, type, preference_id, repo_id, scope, summary, detail, agent_id, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    e.type,
    e.preferenceId ?? null,
    e.repoId ?? null,
    e.scope ?? null,
    e.summary,
    e.detail ? JSON.stringify(e.detail) : null,
    e.agentId ?? null,
    e.sessionId ?? null,
    nowIso(),
  );
}

export class EventService {
  constructor(private readonly db: Database) {}

  /** Most-recent-first list of events, optionally scoped to a repo. */
  list(filter?: { repoId?: string | null; limit?: number }): CtxEvent[] {
    const clauses: string[] = [];
    const params: (string | number | null)[] = [];
    if (filter && "repoId" in filter) {
      clauses.push("repo_id IS ?");
      params.push(filter.repoId ?? null);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter?.limit != null ? Math.max(1, Math.floor(filter.limit)) : null;
    const limitSql = limit != null ? "LIMIT ?" : "";
    if (limit != null) params.push(limit);

    // Tiebreak on the implicit rowid (monotonic with insertion) so events created
    // within the same millisecond still come back in reliable chronological order.
    return this.db
      .query<EventRow, (string | number | null)[]>(
        `SELECT * FROM events ${where} ORDER BY created_at DESC, rowid DESC ${limitSql}`,
      )
      .all(...params)
      .map(rowToEvent);
  }
}
