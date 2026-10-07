import type { Repo } from "../repos/repo.ts";
import { inferPrimaryDomain, boundQueryText } from "../preferences/analysis.ts";
import { inferLanguagesFromFiles, normalizeLanguage } from "../preferences/languages.ts";
import { normalizeSlashes } from "../../utils/glob.ts";

/**
 * The normalized, adapter-agnostic view of "what is happening right now" that a
 * conditional preference is evaluated against.
 *
 * It is constructed by an ADAPTER (the Claude prompt hook, the `ctx test-hook`
 * simulator, or `ctx get`) and then handed to the pure evaluator. The evaluator
 * never discovers state on its own — everything it can see is in here. This is the
 * seam that lets future non-Claude adapters reuse the exact same evaluator by
 * building this same object from their own signals.
 */
export interface RuntimeContext {
  /** The working directory the context was built for. */
  cwd: string;
  /** The resolved repository, or null when not in a known repo. */
  repo: { id: string; name: string; identity: string } | null;
  /** The task/prompt text, or null. Used only for domain inference, never language. */
  task: string | null;
  /** Repo-relative, forward-slash file paths known for this turn (may be empty). */
  files: string[];
  /** Canonical languages established from concrete signals (file extensions). */
  languages: Set<string>;
  /** The single best decision domain for the task, or null if none is confident. */
  domain: string | null;
}

export interface BuildRuntimeContextInput {
  cwd: string;
  repo: Repo | null;
  task?: string | null;
  /** Explicit files (e.g. from the simulator). Normalized to forward slashes. */
  files?: readonly string[];
  /** Explicit languages; when given, they OVERRIDE extension inference. */
  languages?: readonly string[];
  /** Explicit domain; when given, it OVERRIDES task-based inference. */
  domain?: string | null;
}

/**
 * Build a normalized RuntimeContext from an adapter's raw signals.
 *
 * Determinism rules, matching the product spec:
 *   - files are normalized to forward slashes;
 *   - languages come from file extensions, UNLESS explicit languages are supplied
 *     (which replace inference) — language is never inferred from task text;
 *   - domain is the single best classifier result for the task, UNLESS an explicit
 *     domain is supplied (which replaces inference). An explicit domain is accepted
 *     verbatim (it is a runtime signal, not a stored condition), so a simulator can
 *     pass any label for debugging.
 */
export function buildRuntimeContext(input: BuildRuntimeContextInput): RuntimeContext {
  // Bound the task to ctx's retrieval-query representation. Every downstream analysis
  // (domain inference here, `taskSignalDomains`, the relevance ranker) reads this, so
  // one bound keeps hook latency flat for huge prompts without altering the agent's
  // prompt. Short tasks pass through unchanged.
  const trimmed = input.task?.trim() || null;
  const task = trimmed != null ? boundQueryText(trimmed) : null;
  const files = (input.files ?? []).map((f) => normalizeSlashes(f)).filter((f) => f.length > 0);

  let languages: Set<string>;
  if (input.languages && input.languages.length > 0) {
    languages = new Set(
      input.languages.map((l) => normalizeLanguage(l) ?? l.trim().toLowerCase()).filter(Boolean),
    );
  } else {
    languages = inferLanguagesFromFiles(files);
  }

  let domain: string | null;
  if (input.domain !== undefined && input.domain !== null) {
    const d = input.domain.trim().toLowerCase();
    domain = d.length > 0 ? d : null;
  } else {
    domain = task ? inferPrimaryDomain(task) : null;
  }

  return {
    cwd: input.cwd,
    repo: input.repo
      ? { id: input.repo.id, name: input.repo.name, identity: input.repo.identity }
      : null,
    task,
    files,
    languages,
    domain,
  };
}
