import { z } from "zod";
import { anyMatchesGlob } from "../../utils/glob.ts";
import { canonicalDomain } from "../signals/domains.ts";
import type { EventFeatures } from "./features.ts";
import { ARTIFACT_SET, OPERATION_SET } from "./vocab.ts";

/**
 * The OPTIONAL machine-readable ACTIVATION SPEC attached to a memory.
 *
 * This NEVER replaces the natural-language rule — the rule stays authoritative. The
 * spec is purely a runtime trigger: a small, flat bag of constrained-vocabulary
 * dimensions. A memory is RELEVANT when any relevance dimension matches an event's
 * features; it is a CONFLICT when any conflict trigger fully matches (which also
 * implies relevance). Scope (`repo`) gates the whole spec.
 *
 * We deliberately do NOT reuse the full Condition AST here: Conditions evaluate
 * against a static RuntimeContext (language/file/domain/repo) for prompt-time
 * retrieval, whereas activation matches *event* features (operations, executables,
 * token cues) that the Condition vocabulary cannot express. The glob matcher and the
 * canonical domain vocabulary ARE reused.
 */
export interface ActivationSpec {
  /** Canonical decision domains this memory cares about. */
  domains?: string[];
  /** Abstract operations (from the OPERATIONS vocabulary). */
  operations?: string[];
  /** Raw host tool names (lowercased), e.g. "bash", "edit". */
  tools?: string[];
  /** Command executables, e.g. "npm", "psql". */
  executables?: string[];
  /** File globs (repo-relative, forward-slash). */
  files?: string[];
  /** Canonical languages. */
  languages?: string[];
  /** Package names. */
  packages?: string[];
  /** Artifact roles (from the ARTIFACTS vocabulary). */
  artifacts?: string[];
  /** Repo-scope: when set, the spec only activates inside this repo identity. */
  repo?: string;
  /** Conflict triggers — any fully-matching trigger raises a conflict. */
  conflicts?: ConflictTrigger[];
}

/**
 * A conflict trigger. Each PRESENT field must match (logical AND across fields);
 * within a field the listed values are OR (set membership / any-glob). `unless`
 * encodes the "preferred alternative" exception — e.g. a package install is only a
 * conflict *unless* the executable was the preferred one (bun).
 */
export interface ConflictTrigger {
  operations?: string[];
  executables?: string[];
  files?: string[];
  artifacts?: string[];
  /** Package names whose presence (e.g. a competing-library install) conflicts. */
  packages?: string[];
  /** Conservative secret token cues that must be present. */
  tokens?: string[];
  /** Suppress the conflict when any of these also match the event. */
  unless?: { executables?: string[]; operations?: string[] };
}

const ConflictTriggerSchema = z
  .object({
    operations: z.array(z.string()).optional(),
    executables: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
    artifacts: z.array(z.string()).optional(),
    packages: z.array(z.string()).optional(),
    tokens: z.array(z.string()).optional(),
    unless: z
      .object({ executables: z.array(z.string()).optional(), operations: z.array(z.string()).optional() })
      .strict()
      .optional(),
  })
  .strict();

export const ActivationSpecSchema = z
  .object({
    domains: z.array(z.string()).optional(),
    operations: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    executables: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
    languages: z.array(z.string()).optional(),
    packages: z.array(z.string()).optional(),
    artifacts: z.array(z.string()).optional(),
    repo: z.string().optional(),
    conflicts: z.array(ConflictTriggerSchema).optional(),
  })
  .strict();

export type RelevanceState = "irrelevant" | "relevant" | "conflict";

export interface MatchResult {
  state: RelevanceState;
  /** The relevance dimensions that fired (for explainability + dataset). */
  relevanceHits: string[];
  /** The conflict trigger index that fired, or -1. */
  conflictTrigger: number;
  /** Human-readable reason. */
  reason: string;
}

function hasIntersection(spec: readonly string[] | undefined, event: ReadonlySet<string>): string | null {
  if (!spec) return null;
  for (const v of spec) if (event.has(v)) return v;
  return null;
}

/** Validate a raw activation spec (throws ZodError on malformed input). */
export function parseActivationSpec(raw: unknown): ActivationSpec {
  return ActivationSpecSchema.parse(raw);
}

/**
 * Validate a spec against the closed vocabulary. Returns the list of unknown terms
 * (empty when the spec is clean). Used by the invariant test, NOT the hot path.
 */
export function unknownVocabTerms(spec: ActivationSpec): string[] {
  const bad: string[] = [];
  for (const o of spec.operations ?? []) if (!OPERATION_SET.has(o)) bad.push(`operation:${o}`);
  for (const a of spec.artifacts ?? []) if (!ARTIFACT_SET.has(a)) bad.push(`artifact:${a}`);
  for (const t of spec.conflicts ?? []) {
    for (const o of t.operations ?? []) if (!OPERATION_SET.has(o)) bad.push(`conflict.operation:${o}`);
    for (const a of t.artifacts ?? []) if (!ARTIFACT_SET.has(a)) bad.push(`conflict.artifact:${a}`);
  }
  return bad;
}

/** Match file globs case-insensitively (authored globs are lowercase; paths vary). */
function anyFileMatch(globs: readonly string[], files: readonly string[]): boolean {
  const lower = files.map((p) => p.toLowerCase());
  return globs.some((g) => anyMatchesGlob(g.toLowerCase(), lower));
}

/** Whether a single conflict trigger fully matches the event features. */
function triggerMatches(t: ConflictTrigger, f: EventFeatures): boolean {
  // Each present field is a required AND-clause.
  if (t.operations && !hasIntersection(t.operations, f.operations as Set<string>)) return false;
  if (t.executables && !hasIntersection(t.executables, f.executables)) return false;
  if (t.artifacts && !hasIntersection(t.artifacts, f.artifacts as Set<string>)) return false;
  if (t.packages && !hasIntersection(t.packages, f.packages)) return false;
  if (t.tokens && !hasIntersection(t.tokens, f.tokenCues)) return false;
  if (t.files && !anyFileMatch(t.files, f.files)) return false;
  // At least one constraint must be present (an empty trigger never fires).
  if (!t.operations && !t.executables && !t.artifacts && !t.packages && !t.tokens && !t.files) return false;
  // Exception: suppress when the preferred alternative is what actually happened.
  if (t.unless) {
    if (t.unless.executables && hasIntersection(t.unless.executables, f.executables)) return false;
    if (t.unless.operations && hasIntersection(t.unless.operations, f.operations as Set<string>)) return false;
  }
  return true;
}

/**
 * Evaluate a memory's activation spec against one event's features. Computes
 * relevance and conflict SEPARATELY (§10). Conflict implies relevance. Scope is
 * applied by the caller (it knows the current repo); a repo-scoped spec passed here
 * is assumed in-scope.
 */
export function matchActivation(spec: ActivationSpec, f: EventFeatures): MatchResult {
  const hits: string[] = [];
  const dom = hasIntersection(spec.domains?.map(canonicalDomain), f.domains);
  if (dom) hits.push(`domain:${dom}`);
  const op = hasIntersection(spec.operations, f.operations as Set<string>);
  if (op) hits.push(`op:${op}`);
  const tool = spec.tools && f.tool && spec.tools.includes(f.tool) ? f.tool : null;
  if (tool) hits.push(`tool:${tool}`);
  const exe = hasIntersection(spec.executables, f.executables);
  if (exe) hits.push(`exe:${exe}`);
  const lang = hasIntersection(spec.languages, f.languages);
  if (lang) hits.push(`lang:${lang}`);
  const pkg = hasIntersection(spec.packages, f.packages);
  if (pkg) hits.push(`pkg:${pkg}`);
  const art = hasIntersection(spec.artifacts, f.artifacts as Set<string>);
  if (art) hits.push(`artifact:${art}`);
  if (spec.files && anyFileMatch(spec.files, f.files)) hits.push("file");

  let conflictTrigger = -1;
  if (spec.conflicts) {
    for (let i = 0; i < spec.conflicts.length; i++) {
      if (triggerMatches(spec.conflicts[i]!, f)) {
        conflictTrigger = i;
        break;
      }
    }
  }

  if (conflictTrigger >= 0) {
    return {
      state: "conflict",
      relevanceHits: hits,
      conflictTrigger,
      reason: `conflict trigger #${conflictTrigger} matched`,
    };
  }
  if (hits.length > 0) {
    return { state: "relevant", relevanceHits: hits, conflictTrigger: -1, reason: `relevance via ${hits.join(", ")}` };
  }
  return { state: "irrelevant", relevanceHits: [], conflictTrigger: -1, reason: "no activation dimension matched" };
}
