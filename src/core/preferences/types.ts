import { z } from "zod";

/**
 * Preference scope. `global` follows the developer everywhere; `repo` is bound
 * to a single repository. The set is intentionally open at the storage layer so
 * `org`/`team` can be added later without a schema migration.
 */
export const Scope = z.enum(["global", "repo"]);
export type Scope = z.infer<typeof Scope>;

/**
 * Preference lifecycle:
 *  - observed: seen but not yet suggested (weakest)
 *  - proposed: an agent suggested it; awaits developer review
 *  - approved: an in-effect rule
 *  - locked:   an in-effect rule that must not be auto-changed (strongest)
 *  - rejected: explicitly declined; never returned by retrieval
 */
export const Status = z.enum([
  "observed",
  "proposed",
  "approved",
  "locked",
  "rejected",
]);
export type Status = z.infer<typeof Status>;

export const Preference = z.object({
  id: z.string(),
  rule: z.string().min(1),
  category: z.string().min(1),
  scope: Scope,
  repoId: z.string().nullable(),
  status: Status,
  confidence: z.number().min(0).max(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type Preference = z.infer<typeof Preference>;

export const Evidence = z.object({
  id: z.string(),
  preferenceId: z.string(),
  source: z.string(),
  repoId: z.string().nullable(),
  evidenceText: z.string(),
  createdAt: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

/** Statuses that represent an in-effect rule returned by `ctx get` by default. */
export const ACTIVE_STATUSES: Status[] = ["locked", "approved"];
