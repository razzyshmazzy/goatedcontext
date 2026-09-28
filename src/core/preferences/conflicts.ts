import type { Preference, Polarity, Scope, Status } from "./types.ts";
import { ACTIVE_STATUSES } from "./types.ts";
import { isExclusiveDomain, subjectKey } from "./analysis.ts";
import { precedenceRank } from "../retrieval/precedence.ts";

/**
 * Detects preference conflicts — sets of active rules that cannot all apply at
 * once — WITHOUT resolving them. It uses the exact same grouping the retrieval
 * conflict-resolver uses (see `resolveConflicts`), so what this reports is
 * precisely what retrieval silently suppresses:
 *
 *  - exclusive domains (package-manager, database, ui-framework, state-management)
 *    admit a single rule; any second rule in the domain competes for that slot.
 *  - other domains admit multiple rules, EXCEPT several rules targeting the same
 *    subject (e.g. "use snapshot testing" vs "never use snapshot testing").
 *
 * This is a read-only diagnostic. `ctx` never auto-resolves conflicts.
 */

export type ConflictKind = "exclusive-domain" | "same-subject";

export interface ConflictMember {
  id: string;
  rule: string;
  scope: Scope;
  status: Status;
  domain: string | null;
  polarity: Polarity;
  /** Retrieval precedence rank (lower wins). */
  precedence: number;
  /** True when this rule is the single highest-precedence member (it applies). */
  applies: boolean;
}

export interface Conflict {
  kind: ConflictKind;
  domain: string | null;
  /** Canonical subject key, for `same-subject` conflicts. */
  subject?: string;
  /** Human-readable explanation of why these rules conflict. */
  reason: string;
  /**
   * True when two or more members share the highest precedence, so precedence
   * alone cannot pick a winner (retrieval falls back to task relevance/order).
   */
  ambiguous: boolean;
  members: ConflictMember[];
}

/** Only in-effect rules can conflict; proposed/observed/rejected are excluded. */
function isActive(p: Preference): boolean {
  return (ACTIVE_STATUSES as string[]).includes(p.status);
}

function toMember(p: Preference, applies: boolean): ConflictMember {
  return {
    id: p.id,
    rule: p.rule,
    scope: p.scope,
    status: p.status,
    domain: p.domain,
    polarity: p.polarity,
    precedence: precedenceRank(p),
    applies,
  };
}

function buildConflict(kind: ConflictKind, domain: string | null, subject: string | undefined, group: Preference[]): Conflict {
  // Sort by precedence (winner first); ties keep input order.
  const ordered = group
    .map((p, i) => ({ p, i }))
    .sort((a, b) => precedenceRank(a.p) - precedenceRank(b.p) || a.i - b.i)
    .map((x) => x.p);

  const topRank = precedenceRank(ordered[0]!);
  const topCount = ordered.filter((p) => precedenceRank(p) === topRank).length;
  const ambiguous = topCount > 1;
  const winnerId = ambiguous ? null : ordered[0]!.id;

  const members = ordered.map((p) => toMember(p, p.id === winnerId));

  const hasPos = group.some((p) => p.polarity === "positive");
  const hasNeg = group.some((p) => p.polarity === "negative");

  let reason: string;
  if (kind === "exclusive-domain") {
    reason = `Exclusive domain "${domain}" admits a single rule; only one applies and the rest are suppressed during retrieval.`;
  } else if (hasPos && hasNeg) {
    reason = "These rules target the same subject with opposing polarity — a direct contradiction.";
  } else {
    reason = "These rules target the same subject; only one applies and the rest are suppressed during retrieval.";
  }

  return { kind, domain, subject, reason, ambiguous, members };
}

/**
 * Find every conflict among a set of preferences. The caller decides the scope of
 * the set (global-only, or a repo's effective set = repo + global); this function
 * only groups and explains.
 */
export function findConflicts(prefs: Preference[]): Conflict[] {
  const active = prefs.filter(isActive);

  const exclusive = new Map<string, Preference[]>();
  const subjects = new Map<string, { domain: string | null; subject: string; group: Preference[] }>();

  for (const p of active) {
    if (isExclusiveDomain(p.domain)) {
      const key = p.domain!;
      const group = exclusive.get(key) ?? [];
      group.push(p);
      exclusive.set(key, group);
    } else {
      const subject = subjectKey(p.rule);
      // Rules with no meaningful subject tokens can't be compared by subject.
      if (!subject) continue;
      const key = `${p.domain ?? ""}|${subject}`;
      const entry = subjects.get(key) ?? { domain: p.domain, subject, group: [] };
      entry.group.push(p);
      subjects.set(key, entry);
    }
  }

  const conflicts: Conflict[] = [];
  for (const [domain, group] of exclusive) {
    if (group.length >= 2) conflicts.push(buildConflict("exclusive-domain", domain, undefined, group));
  }
  for (const { domain, subject, group } of subjects.values()) {
    if (group.length >= 2) conflicts.push(buildConflict("same-subject", domain, subject, group));
  }

  // Stable, readable ordering: exclusive-domain first, then by domain name.
  conflicts.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "exclusive-domain" ? -1 : 1;
    return (a.domain ?? "").localeCompare(b.domain ?? "") || (a.subject ?? "").localeCompare(b.subject ?? "");
  });
  return conflicts;
}
