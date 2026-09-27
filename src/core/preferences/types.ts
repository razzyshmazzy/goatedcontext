import { z } from "zod";
import { KNOWN_DOMAINS } from "./analysis.ts";

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

/** Directive polarity, preserved so opposite rules never merge. */
export const Polarity = z.enum(["positive", "negative", "neutral"]);
export type Polarity = z.infer<typeof Polarity>;

/** An explicit domain must be one of the known domains (extensible list). */
export const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .refine((d) => KNOWN_DOMAINS.includes(d), {
    message: `Unknown domain. Known domains: ${KNOWN_DOMAINS.join(", ")}`,
  });

export const Preference = z.object({
  id: z.string(),
  rule: z.string().min(1),
  category: z.string().min(1),
  domain: z.string().nullable(),
  polarity: Polarity,
  scope: Scope,
  repoId: z.string().nullable(),
  status: Status,
  confidence: z.number().min(0).max(1),
  version: z.number().int().min(1),
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
  agentId: z.string().nullable(),
  sessionId: z.string().nullable(),
  createdAt: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

/** Statuses that represent an in-effect rule returned by `ctx get` by default. */
export const ACTIVE_STATUSES: Status[] = ["locked", "approved"];

// ---- write-path validation schemas -----------------------------------------
//
// Every user-controlled mutation is validated through these before touching the
// database, so invalid writes fail loudly and never persist.

/** A non-empty, non-whitespace-only string, trimmed. */
const NonEmptyText = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length > 0, { message: "must not be empty or whitespace-only" });

/** A category: non-empty, lowercased, reasonable length. */
const Category = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => s.length > 0, { message: "category must not be empty" })
  .refine((s) => s.length <= 64, { message: "category is too long" });

/** Optional provenance attached to evidence/mutations. */
export const Provenance = z.object({
  agentId: z.string().trim().max(128).optional(),
  sessionId: z.string().trim().max(128).optional(),
});
export type Provenance = z.infer<typeof Provenance>;

export const RememberInputSchema = z.object({
  rule: NonEmptyText,
  category: Category.default("general"),
  domain: Domain.nullable().optional(),
  scope: Scope,
  repoId: z.string().nullable().optional(),
  status: Status.optional(),
  source: z.string().optional(),
  evidence: z.string().optional(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
});
export type RememberInput = z.infer<typeof RememberInputSchema>;

export const ProposeInputSchema = z.object({
  rule: NonEmptyText,
  category: Category.default("general"),
  domain: Domain.nullable().optional(),
  scope: Scope,
  repoId: z.string().nullable().optional(),
  evidence: NonEmptyText,
  source: z.string().optional(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
});
export type ProposeInput = z.infer<typeof ProposeInputSchema>;
