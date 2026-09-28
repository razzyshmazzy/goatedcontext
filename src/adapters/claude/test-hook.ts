import type { CtxContext } from "../../core/context.ts";
import { formatHookContext } from "./hook.ts";
import type {
  RetrievedPreference,
  RetrievalResult,
} from "../../core/retrieval/retrieval.ts";

/**
 * Result of simulating the Claude prompt-retrieval hook for a task. This is a
 * faithful dry run of the SAME path `ctx hook claude-prompt` takes (retrieve with
 * `track: false`, then `formatHookContext`), so it exposes exactly what Claude
 * would receive — and nothing more. Never contains secret values.
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
  /** Environments referenced by the block (names/availability only — never values). */
  environments: { name: string; scope: string; riskLevel: string; available: boolean; variableNames: string[] }[];
}

/**
 * Run the prompt-hook retrieval path for `task` without launching Claude.
 *
 * Mirrors the hook's guard: an empty/whitespace task injects nothing (the real
 * hook returns early before retrieval), while the repo is still resolved so the
 * caller can see what was detected.
 */
export function simulateHook(ctx: CtxContext, opts: { cwd: string; task: string }): TestHookResult {
  const task = (opts.task ?? "").toString();

  if (!task.trim()) {
    const repo = ctx.repos.resolve(opts.cwd);
    return {
      task,
      repo: repo ? { id: repo.id, name: repo.name, identity: repo.identity } : null,
      wouldInject: false,
      block: null,
      preferences: [],
      overridden: [],
      environments: [],
    };
  }

  const result = ctx.retrieval.retrieve({ cwd: opts.cwd, task, track: false });
  const block = formatHookContext(result);
  return {
    task,
    repo: result.repo,
    wouldInject: block !== null,
    block,
    preferences: result.preferences,
    overridden: result.overridden,
    environments: result.environments.map((e) => ({
      name: e.name,
      scope: e.scope,
      riskLevel: e.riskLevel,
      available: e.available,
      variableNames: e.variableNames,
    })),
  };
}
