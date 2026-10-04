import type { CtxContext } from "../../core/context.ts";
import { formatHookContext } from "./hook.ts";
import type {
  RetrievedPreference,
  RetrievalResult,
  RuntimeContextView,
  ConditionalEvaluation,
} from "../../core/retrieval/retrieval.ts";

/**
 * Result of simulating the Claude prompt-retrieval hook for a task. This is a
 * faithful dry run of the SAME path `ctx hook claude-prompt` takes (retrieve with
 * `track: false`, then `formatHookContext`), so it exposes exactly what Claude
 * would receive — and nothing more. Never contains secret values.
 *
 * Unlike the live hook, the simulator can be given explicit `files`/`languages`/
 * `domain` so conditional preferences that depend on richer runtime context can be
 * debugged. It also exposes the normalized runtime context and the per-conditional
 * evaluation trace (`explain`), which the live hook never computes.
 */
export interface TestHookResult {
  task: string;
  repo: { id: string; name: string; identity: string } | null;
  /** True when a non-empty context block would be prepended to the prompt. */
  wouldInject: boolean;
  /** The exact text that would be injected, or null when nothing is relevant. */
  block: string | null;
  /** Preferences that matched and would be shown to Claude. */
  preferences: RetrievedPreference[];
  /** Preferences dropped because a higher-precedence rule superseded them. */
  overridden: RetrievalResult["overridden"];
  /** The normalized runtime context used for conditional evaluation. */
  runtimeContext: RuntimeContextView;
  /** Evaluation result for every conditional candidate (matched and not). */
  conditionalEvaluations: ConditionalEvaluation[];
  /** Environments referenced by the block (names/availability only — never values). */
  environments: { name: string; scope: string; riskLevel: string; available: boolean; variableNames: string[] }[];
}

export interface SimulateHookOptions {
  cwd: string;
  task: string;
  /** Explicit active files (e.g. `src/App.tsx`); enables file/language conditions. */
  files?: string[];
  /** Explicit languages; override extension inference. */
  languages?: string[];
  /** Explicit domain; overrides task-based inference. */
  domain?: string | null;
}

function emptyRuntimeContext(
  cwd: string,
  repo: { id: string; name: string; identity: string } | null,
): RuntimeContextView {
  return { cwd, repo: repo ?? null, task: null, files: [], languages: [], domain: null };
}

/**
 * Run the prompt-hook retrieval path for `task` without launching Claude.
 *
 * Mirrors the hook's guard: an empty/whitespace task injects nothing (the real
 * hook returns early before retrieval), while the repo is still resolved so the
 * caller can see what was detected.
 */
export function simulateHook(ctx: CtxContext, opts: SimulateHookOptions): TestHookResult {
  const task = (opts.task ?? "").toString();

  if (!task.trim()) {
    const repo = ctx.repos.resolve(opts.cwd);
    const repoView = repo ? { id: repo.id, name: repo.name, identity: repo.identity } : null;
    return {
      task,
      repo: repoView,
      wouldInject: false,
      block: null,
      preferences: [],
      overridden: [],
      runtimeContext: emptyRuntimeContext(opts.cwd, repoView),
      conditionalEvaluations: [],
      environments: [],
    };
  }

  const result = ctx.retrieval.retrieve({
    cwd: opts.cwd,
    task,
    track: false,
    explain: true,
    files: opts.files,
    languages: opts.languages,
    domain: opts.domain,
  });
  const block = formatHookContext(result);
  return {
    task,
    repo: result.repo,
    wouldInject: block !== null,
    block,
    preferences: result.preferences,
    overridden: result.overridden,
    runtimeContext: result.runtimeContext ?? emptyRuntimeContext(opts.cwd, result.repo),
    conditionalEvaluations: result.conditionalEvaluations ?? [],
    environments: result.environments.map((e) => ({
      name: e.name,
      scope: e.scope,
      riskLevel: e.riskLevel,
      available: e.available,
      variableNames: e.variableNames,
    })),
  };
}
