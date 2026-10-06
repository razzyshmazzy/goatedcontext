/**
 * Deterministic, dependency-free canonicalization for signal fields. Kept in its
 * own tiny module (no imports from the service or the domain-alias layer) so both
 * `SignalService` and the canonical-domain matcher can depend on it without a cycle.
 * This is NOT semantics — only string canonicalization.
 */

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

/** Normalize a constraint category to a kebab token (same canonicalization as domains). */
export function normalizeConstraint(raw: string): string {
  return normalizeDomain(raw);
}
