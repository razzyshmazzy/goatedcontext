import type { Condition } from "../preferences/conditions.ts";
import type { RuntimeContext } from "./runtime-context.ts";
import { firstMatchingPath } from "../../utils/glob.ts";
import { normalizeLanguage } from "../preferences/languages.ts";

/**
 * The pure, deterministic condition evaluator — the core of 0.2.8.
 *
 * It is a total function of `(condition, runtimeContext)` with NO side effects and
 * NO hidden state discovery: it reads only what the adapter put into the
 * RuntimeContext. This is what keeps it reusable across agent adapters.
 *
 * Missing-context semantics (the spec's central rule): if the context required to
 * decide a leaf is unavailable, the leaf does NOT match — it never falls back to
 * guessing or to semantic relevance. "Never guess."
 */
export interface EvalResult {
  matched: boolean;
  /** A short, human-readable explanation of this node's decision. */
  reason: string;
  /** Child results for `all`/`any`/`not`, for nested explainability. */
  children?: EvalResult[];
}

export function evaluateCondition(cond: Condition, ctx: RuntimeContext): EvalResult {
  if ("language" in cond) return evalLanguage(cond.language, ctx);
  if ("file" in cond) return evalFile(cond.file, ctx);
  if ("domain" in cond) return evalDomain(cond.domain, ctx);
  if ("repo" in cond) return evalRepo(cond.repo, ctx);
  if ("all" in cond) return evalAll(cond.all, ctx);
  if ("any" in cond) return evalAny(cond.any, ctx);
  return evalNot((cond as { not: Condition }).not, ctx);
}

function evalLanguage(languageRaw: string, ctx: RuntimeContext): EvalResult {
  const language = normalizeLanguage(languageRaw) ?? languageRaw;
  if (ctx.languages.size === 0) {
    return { matched: false, reason: `language ${language} not evaluable — no language in context` };
  }
  if (ctx.languages.has(language)) {
    return { matched: true, reason: `language matched ${language}` };
  }
  return {
    matched: false,
    reason: `language ${language} not present (context: ${[...ctx.languages].sort().join(", ")})`,
  };
}

function evalFile(pattern: string, ctx: RuntimeContext): EvalResult {
  if (ctx.files.length === 0) {
    return { matched: false, reason: `file context unavailable (pattern ${pattern})` };
  }
  const hit = firstMatchingPath(pattern, ctx.files);
  if (hit) return { matched: true, reason: `file ${hit} matched ${pattern}` };
  return { matched: false, reason: `no file matched ${pattern}` };
}

function evalDomain(domain: string, ctx: RuntimeContext): EvalResult {
  if (ctx.domain == null) {
    return { matched: false, reason: `domain context unavailable (expected ${domain})` };
  }
  if (ctx.domain === domain) return { matched: true, reason: `domain matched ${domain}` };
  return { matched: false, reason: `domain ${ctx.domain} did not match ${domain}` };
}

function evalRepo(identity: string, ctx: RuntimeContext): EvalResult {
  if (ctx.repo == null) {
    return { matched: false, reason: `repo context unavailable (expected ${identity})` };
  }
  if (ctx.repo.identity === identity) {
    return { matched: true, reason: `repo matched ${ctx.repo.name}` };
  }
  return { matched: false, reason: `repo ${ctx.repo.identity} did not match ${identity}` };
}

function evalAll(children: Condition[], ctx: RuntimeContext): EvalResult {
  // Defensive: validation forbids an empty array, but never trust the caller.
  if (children.length === 0) return { matched: false, reason: "invalid empty `all`" };
  const results: EvalResult[] = [];
  for (const child of children) {
    const r = evaluateCondition(child, ctx);
    results.push(r);
    if (!r.matched) {
      return { matched: false, reason: `ALL failed: ${r.reason}`, children: results };
    }
  }
  return { matched: true, reason: "ALL matched", children: results };
}

function evalAny(children: Condition[], ctx: RuntimeContext): EvalResult {
  if (children.length === 0) return { matched: false, reason: "invalid empty `any`" };
  const results: EvalResult[] = [];
  for (const child of children) {
    const r = evaluateCondition(child, ctx);
    results.push(r);
    if (r.matched) {
      return { matched: true, reason: `ANY matched: ${r.reason}`, children: results };
    }
  }
  return { matched: false, reason: "ANY matched none", children: results };
}

function evalNot(child: Condition, ctx: RuntimeContext): EvalResult {
  const r = evaluateCondition(child, ctx);
  return {
    matched: !r.matched,
    reason: r.matched ? `NOT failed: ${r.reason}` : `NOT satisfied: ${r.reason}`,
    children: [r],
  };
}
