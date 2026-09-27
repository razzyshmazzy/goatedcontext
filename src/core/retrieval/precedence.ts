import type { Preference } from "../preferences/types.ts";

/**
 * Precedence ranking. LOWER numbers win. Isolated and pure so it can be tested
 * exhaustively and reused by any adapter.
 *
 *   1. locked repo preference
 *   2. approved repo preference
 *   3. locked global preference
 *   4. approved global preference
 *   5. proposed / observed preferences
 *
 * `rejected` preferences are never eligible (Infinity).
 */
export function precedenceRank(p: Preference): number {
  if (p.status === "rejected") return Number.POSITIVE_INFINITY;

  const isRepo = p.scope === "repo";
  switch (p.status) {
    case "locked":
      return isRepo ? 1 : 3;
    case "approved":
      return isRepo ? 2 : 4;
    case "proposed":
    case "observed":
      return 5;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

/** True when `a` has strictly higher precedence (wins over) `b`. */
export function outranks(a: Preference, b: Preference): boolean {
  return precedenceRank(a) < precedenceRank(b);
}

/**
 * Given two preferences that address the same topic, return the one that should
 * be applied. Repo-specific instructions override global defaults.
 */
export function resolveConflict(a: Preference, b: Preference): Preference {
  return outranks(a, b) ? a : b;
}
