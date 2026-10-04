import { z } from "zod";
import { nowIso } from "../../utils/time.ts";
import { Applicability, Polarity, Scope, Status } from "../preferences/types.ts";
import { ConditionSchema, canonicalizeCondition } from "../preferences/conditions.ts";
import type { CtxContext } from "../context.ts";

/**
 * Portable export/import of developer context.
 *
 * HARD RULE: secret values are NEVER exported. Preference rules and evidence are
 * plain developer text (no secrets), and environments — which reference secrets —
 * are intentionally excluded entirely.
 *
 * The bundle is machine-portable: it carries no local row ids. Repo-scoped
 * preferences link to a repo by its stable `identity` (e.g. `remote:github.com/acme/app`),
 * which survives moves and re-clones for repos with a remote. Path-only identities
 * are local by nature and simply create a fresh repo record on another machine.
 */

export const EXPORT_SCHEMA = "ctx-export";
export const EXPORT_VERSION = 1;

const ExportEvidence = z.object({
  source: z.string(),
  text: z.string(),
  agentId: z.string().nullable().default(null),
  sessionId: z.string().nullable().default(null),
  createdAt: z.string().optional(),
});

const ExportRepo = z.object({
  identity: z.string().min(1),
  name: z.string(),
  remoteUrl: z.string().nullable().default(null),
  hasRemote: z.boolean().default(false),
  rootPath: z.string().default(""),
});

const ExportPreference = z
  .object({
    rule: z.string().min(1),
    category: z.string().min(1),
    domain: z.string().nullable().default(null),
    polarity: Polarity,
    scope: Scope,
    status: Status,
    // Additive + default-safe: bundles from ≤0.2.3 have no applicability field and
    // import as `relevant`, preserving their original behavior. No schema-version
    // bump is needed for this reason.
    applicability: Applicability.default("relevant"),
    // Additive + default-safe: bundles from ≤0.2.7 have no condition field and
    // import as `null` (correct for every relevant/always row they contain). The
    // structured condition is validated by the SAME schema used everywhere, so a
    // malformed condition fails the import. No schema-version bump is needed.
    condition: ConditionSchema.nullable().default(null),
    confidence: z.number().min(0).max(1).default(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    /** Links to `repos[].identity`; required for repo-scoped prefs, null for global. */
    repoIdentity: z.string().nullable().default(null),
    evidence: z.array(ExportEvidence).default([]),
  })
  // Enforce the applicability/condition invariant at the boundary: a conditional
  // row without a condition, or a relevant/always row carrying one, is rejected —
  // never silently coerced.
  .superRefine((p, ctx) => {
    if (p.applicability === "conditional" && !p.condition) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["condition"],
        message: "a conditional preference requires a condition",
      });
    }
    if (p.applicability !== "conditional" && p.condition) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["condition"],
        message: `a ${p.applicability} preference must not carry a condition`,
      });
    }
  });

export const ExportBundleSchema = z.object({
  schema: z.literal(EXPORT_SCHEMA),
  version: z.number().int().positive(),
  exportedAt: z.string(),
  repos: z.array(ExportRepo).default([]),
  preferences: z.array(ExportPreference).default([]),
});

export type ExportBundle = z.infer<typeof ExportBundleSchema>;

export interface ImportSummary {
  imported: number;
  skipped: number;
  reposLinked: number;
  total: number;
}

/** Build a portable, secret-free bundle of all preferences, evidence and repos. */
export function exportData(ctx: CtxContext): ExportBundle {
  const prefs = ctx.preferences.list();

  // Only include repos actually referenced by an exported preference.
  const referenced = new Set(prefs.filter((p) => p.repoId).map((p) => p.repoId!));
  const repos = ctx.repos
    .list()
    .filter((r) => referenced.has(r.id))
    .map((r) => ({
      identity: r.identity,
      name: r.name,
      remoteUrl: r.remoteUrl,
      hasRemote: r.hasRemote,
      rootPath: r.rootPath,
    }));
  const repoIdentityById = new Map(ctx.repos.list().map((r) => [r.id, r.identity]));

  const preferences = prefs
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((p) => ({
      rule: p.rule,
      category: p.category,
      domain: p.domain,
      polarity: p.polarity,
      scope: p.scope,
      status: p.status,
      applicability: p.applicability,
      // Emit the CANONICAL condition so JSON key/member ordering never produces a
      // spurious diff or a duplicate on re-import.
      condition: p.condition ? canonicalizeCondition(p.condition) : null,
      confidence: p.confidence,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      repoIdentity: p.repoId ? repoIdentityById.get(p.repoId) ?? null : null,
      evidence: ctx.preferences.evidenceFor(p.id).map((e) => ({
        source: e.source,
        text: e.evidenceText,
        agentId: e.agentId,
        sessionId: e.sessionId,
        createdAt: e.createdAt,
      })),
    }));

  return {
    schema: EXPORT_SCHEMA,
    version: EXPORT_VERSION,
    exportedAt: nowIso(),
    repos,
    preferences,
  };
}

/**
 * Import a bundle, idempotently. Duplicate preferences (same scope + repo +
 * subject + polarity) are merged rather than duplicated; contradictions (opposite
 * polarity) are preserved. Existing preferences are never mutated in place.
 * Throws a ZodError on a malformed bundle.
 */
export function importData(ctx: CtxContext, raw: unknown): ImportSummary {
  const bundle = ExportBundleSchema.parse(raw);

  // Resolve/create each referenced repo once, mapping export identity → local id.
  const repoIdByIdentity = new Map<string, string>();
  const linkedIdentities = new Set<string>();
  for (const r of bundle.repos) {
    const repo = ctx.repos.ensureByIdentity({
      identity: r.identity,
      name: r.name,
      remoteUrl: r.remoteUrl,
      hasRemote: r.hasRemote,
      rootPath: r.rootPath,
    });
    repoIdByIdentity.set(r.identity, repo.id);
  }

  let imported = 0;
  let skipped = 0;
  for (const p of bundle.preferences) {
    let repoId: string | null = null;
    if (p.scope === "repo") {
      if (!p.repoIdentity) {
        skipped++; // repo-scoped pref without a resolvable repo — skip safely
        continue;
      }
      repoId = repoIdByIdentity.get(p.repoIdentity) ?? null;
      if (!repoId) {
        skipped++;
        continue;
      }
      linkedIdentities.add(p.repoIdentity);
    }

    const result = ctx.preferences.importOne(
      {
        rule: p.rule,
        category: p.category,
        domain: p.domain,
        polarity: p.polarity,
        scope: p.scope,
        status: p.status,
        applicability: p.applicability,
        condition: p.condition,
        confidence: p.confidence,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        evidence: p.evidence.map((e) => ({
          source: e.source,
          text: e.text,
          agentId: e.agentId,
          sessionId: e.sessionId,
        })),
      },
      repoId,
    );
    if (result.created) imported++;
    else skipped++;
  }

  return {
    imported,
    skipped,
    reposLinked: linkedIdentities.size,
    total: bundle.preferences.length,
  };
}
