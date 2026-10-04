import { z } from "zod";
import { KNOWN_DOMAINS } from "./analysis.ts";
import { normalizeLanguage } from "./languages.ts";
import { normalizeSlashes } from "../../utils/glob.ts";
import { CtxError } from "../../utils/errors.ts";

/**
 * Structured condition AST for `conditional` preferences (0.2.8).
 *
 * A condition is PURE DATA — a serializable rule, never executable code, a shell
 * command, or an LLM prompt. It is evaluated deterministically against a
 * normalized `RuntimeContext` (see `src/core/retrieval/runtime-context.ts`). The
 * same AST and evaluator will later back non-Claude adapters, so nothing here
 * knows about Claude or the filesystem.
 *
 * Supported in 0.2.8 (and only these):
 *
 *   { language: string }   — a canonical programming language
 *   { file: string }       — a forward-slash glob over the runtime's known files
 *   { domain: string }     — a known decision domain (reuses the domain classifier)
 *   { repo: string }       — a canonical repo identity
 *   { all: Condition[] }   — logical AND (non-empty)
 *   { any: Condition[] }   — logical OR  (non-empty)
 *   { not: Condition }     — logical NOT (exactly one child)
 */
export type Condition =
  | { language: string }
  | { file: string }
  | { domain: string }
  | { repo: string }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

// ---- leaf value schemas -----------------------------------------------------

/** A language value, normalized to its canonical name; unknown languages reject. */
const LanguageValue = z
  .string()
  .transform((s) => s.trim())
  .superRefine((s, ctx) => {
    if (normalizeLanguage(s) === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown language "${s}". Known: typescript, javascript, python, rust, go, java, c, cpp, csharp, ruby, php, swift, kotlin, html, css, sql (aliases like ts/js/py/c++/cs accepted).`,
      });
    }
  })
  .transform((s) => normalizeLanguage(s)!);

/** A file glob value: forward-slash normalized, non-empty. */
const FileValue = z
  .string()
  .transform((s) => normalizeSlashes(s))
  .refine((s) => s.length > 0, { message: "file condition must not be empty" });

/** A domain value: must be one of the known decision domains. */
const DomainValue = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .refine((d) => KNOWN_DOMAINS.includes(d), {
    message: `Unknown domain. Known domains: ${KNOWN_DOMAINS.join(", ")}`,
  });

/** A repo value: an already-resolved canonical identity (non-empty). */
const RepoValue = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length > 0, { message: "repo condition must not be empty" });

/**
 * The recursive Condition schema. Objects are `.strict()` so a leaf can never
 * smuggle extra keys, and a node is exactly one of the seven shapes. `all`/`any`
 * require a non-empty array; `not` takes exactly one child.
 */
export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ language: LanguageValue }).strict(),
    z.object({ file: FileValue }).strict(),
    z.object({ domain: DomainValue }).strict(),
    z.object({ repo: RepoValue }).strict(),
    z
      .object({ all: z.array(ConditionSchema).min(1, "`all` must have at least one condition") })
      .strict(),
    z
      .object({ any: z.array(ConditionSchema).min(1, "`any` must have at least one condition") })
      .strict(),
    z.object({ not: ConditionSchema }).strict(),
  ]),
) as z.ZodType<Condition>;

/** Parse/validate an arbitrary value into a Condition (throws ZodError if invalid). */
export function parseCondition(raw: unknown): Condition {
  return ConditionSchema.parse(raw);
}

// ---- canonicalization -------------------------------------------------------

/**
 * Produce a canonical form of a condition so that two logically-equal conditions
 * serialize identically regardless of how they were written:
 *   - leaves are already normalized by the schema;
 *   - `all`/`any` children are canonicalized and sorted by their canonical JSON,
 *     so member ORDER never affects identity;
 *   - every node has exactly one key, so object key order is never ambiguous.
 */
export function canonicalizeCondition(c: Condition): Condition {
  if ("all" in c) {
    const children = c.all.map(canonicalizeCondition);
    children.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { all: children };
  }
  if ("any" in c) {
    const children = c.any.map(canonicalizeCondition);
    children.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { any: children };
  }
  if ("not" in c) return { not: canonicalizeCondition(c.not) };
  return c;
}

/** Stable canonical JSON string for storage/equality (order-independent). */
export function conditionToCanonicalJson(c: Condition): string {
  return JSON.stringify(canonicalizeCondition(c));
}

/** Parse a stored canonical JSON string back into a Condition (null-safe). */
export function conditionFromJson(json: string | null): Condition | null {
  if (json == null) return null;
  const trimmed = json.trim();
  if (trimmed.length === 0) return null;
  return parseCondition(JSON.parse(trimmed));
}

// ---- rendering --------------------------------------------------------------

function leafText(c: Condition): string | null {
  if ("language" in c) return `language = ${c.language}`;
  if ("file" in c) return `file = ${c.file}`;
  if ("domain" in c) return `domain = ${c.domain}`;
  if ("repo" in c) return `repo = ${c.repo}`;
  return null;
}

/**
 * Multi-line, indented rendering for `ctx why`. Example:
 *   ALL
 *     language = typescript
 *     file = src/**\/*.ts
 */
export function renderConditionLines(c: Condition, indent = 0): string[] {
  const pad = "  ".repeat(indent);
  const leaf = leafText(c);
  if (leaf) return [`${pad}${leaf}`];
  if ("all" in c) return [`${pad}ALL`, ...c.all.flatMap((k) => renderConditionLines(k, indent + 1))];
  if ("any" in c) return [`${pad}ANY`, ...c.any.flatMap((k) => renderConditionLines(k, indent + 1))];
  return [`${pad}NOT`, ...renderConditionLines((c as { not: Condition }).not, indent + 1)];
}

/**
 * One-line compact expression for `ctx prefs`. Examples:
 *   language=typescript
 *   all(language=typescript, file=src/**\/*.ts)
 *   not(domain=database)
 */
export function compactCondition(c: Condition): string {
  if ("language" in c) return `language=${c.language}`;
  if ("file" in c) return `file=${c.file}`;
  if ("domain" in c) return `domain=${c.domain}`;
  if ("repo" in c) return `repo=${c.repo}`;
  if ("all" in c) return `all(${c.all.map(compactCondition).join(", ")})`;
  if ("any" in c) return `any(${c.any.map(compactCondition).join(", ")})`;
  return `not(${compactCondition((c as { not: Condition }).not)})`;
}

// ---- `--when key=value` parsing --------------------------------------------

const WHEN_KEYS = new Set(["language", "file", "domain", "repo"]);

export interface WhenLeaf {
  key: "language" | "file" | "domain" | "repo";
  value: string;
}

/**
 * Parse a single `--when key=value` flag into a raw key/value pair. This performs
 * ONLY structural parsing (split on the first `=`, whitespace-normalized) — it does
 * NOT interpret the value as an expression. `language=typescript && domain=frontend`
 * yields the literal value `typescript && domain=frontend`, which later fails
 * language validation; logical composition comes only from repeated flags or the
 * structured JSON form. Unknown keys and empty values are rejected.
 */
export function parseWhenFlag(raw: string): WhenLeaf {
  const trimmed = raw.trim();
  const eq = trimmed.indexOf("=");
  if (eq < 0) {
    throw new CtxError(
      `Invalid --when "${raw}": expected key=value (keys: language, file, domain, repo).`,
    );
  }
  const key = trimmed.slice(0, eq).trim().toLowerCase();
  const value = trimmed.slice(eq + 1).trim();
  if (!WHEN_KEYS.has(key)) {
    throw new CtxError(
      `Unknown --when key "${key}". Supported keys: language, file, domain, repo.`,
    );
  }
  if (value.length === 0) {
    throw new CtxError(`--when ${key} requires a non-empty value (got "${raw}").`);
  }
  return { key: key as WhenLeaf["key"], value };
}

/** Repo resolver: turn a friendly repo value into a canonical identity, or throw. */
export type RepoResolver = (value: string) => string;

/**
 * Walk a condition and resolve every `repo` leaf's value through `resolver`
 * (friendly name → canonical identity). Used by the advanced `--when-json` path so
 * JSON conditions get the same repo normalization as `--when repo=…`.
 */
export function resolveRepoLeaves(c: Condition, resolver: RepoResolver): Condition {
  if ("repo" in c) return { repo: resolver(c.repo) };
  if ("all" in c) return { all: c.all.map((k) => resolveRepoLeaves(k, resolver)) };
  if ("any" in c) return { any: c.any.map((k) => resolveRepoLeaves(k, resolver)) };
  if ("not" in c) return { not: resolveRepoLeaves((c as { not: Condition }).not, resolver) };
  return c;
}

/**
 * Build a Condition from one or more `--when` flags. A single flag is a leaf;
 * multiple flags are ANDed (`{ all: [...] }`). Repo leaves are resolved to a
 * canonical identity via `repoResolver`. The result is validated and canonicalized.
 */
export function buildWhenCondition(flags: string[], repoResolver: RepoResolver): Condition {
  if (flags.length === 0) {
    throw new CtxError("At least one --when key=value is required for a conditional preference.");
  }
  // Validate each leaf against its SPECIFIC rule (not the union) so the error names
  // the exact problem (`Unknown language "cobol"`) instead of a generic union miss.
  const leaves: Condition[] = flags.map((f) => {
    const { key, value } = parseWhenFlag(f);
    switch (key) {
      case "language": {
        const lang = normalizeLanguage(value);
        if (lang === null) {
          throw new CtxError(
            `Unknown language "${value}". Known: typescript, javascript, python, rust, go, java, c, cpp, csharp, ruby, php, swift, kotlin, html, css, sql (aliases like ts/js/py/c++/cs accepted).`,
          );
        }
        return { language: lang };
      }
      case "domain": {
        const d = value.toLowerCase();
        if (!KNOWN_DOMAINS.includes(d)) {
          throw new CtxError(`Unknown domain "${value}". Known domains: ${KNOWN_DOMAINS.join(", ")}.`);
        }
        return { domain: d };
      }
      case "file":
        return { file: normalizeSlashes(value) };
      case "repo":
        return { repo: repoResolver(value) };
    }
  });
  const raw: Condition = leaves.length === 1 ? leaves[0]! : { all: leaves };
  // Final safety pass through the full schema (leaves are already valid).
  return canonicalizeCondition(parseCondition(raw));
}

// ---- applicability/condition invariants ------------------------------------

/**
 * Enforce the core invariants shared by every write path (remember/propose/import):
 *   - relevant / always  => condition MUST be null
 *   - conditional        => a valid condition is REQUIRED
 * Returns the canonicalized condition (or null) to persist. Throws on violation so
 * the caller performs no write.
 */
export function enforceConditionInvariant(
  applicability: string,
  condition: Condition | null | undefined,
): Condition | null {
  if (applicability === "conditional") {
    if (!condition) {
      throw new CtxError("A conditional preference requires a condition (use --when ...).");
    }
    return canonicalizeCondition(parseCondition(condition));
  }
  if (condition) {
    throw new CtxError(
      `A ${applicability} preference must not carry a condition; conditions are only for conditional preferences.`,
    );
  }
  return null;
}
