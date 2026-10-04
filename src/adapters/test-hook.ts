import type { CtxContext } from "../core/context.ts";
import { renderContextBlock } from "../core/render/context-block.ts";
import type {
  RetrievedPreference,
  RetrievalResult,
  RuntimeContextView,
  ConditionalEvaluation,
} from "../core/retrieval/retrieval.ts";
import { buildRuntimeContext } from "../core/retrieval/runtime-context.ts";
import type { Repo } from "../core/repos/repo.ts";
import { planDelivery } from "../core/agents/delivery.ts";
import { capabilitiesFor, type AgentCapabilities, type AgentId } from "../core/agents/capabilities.ts";

/**
 * Adapter-neutral dry run of what an agent would receive for a task — the shared
 * debugging surface behind `ctx test-hook --agent <id>`.
 *
 * It exposes, for the chosen agent:
 *   - the normalized RuntimeContext,
 *   - the matched preferences and (for conditionals) why,
 *   - the delivery plan: which preference IDs are static / runtime / unsupported,
 *   - the EXACT native runtime output where runtime injection exists.
 *
 * For an agent without runtime injection (Cursor) it honestly reports
 * `runtimeSupported: false` and a null block rather than fabricating a hook result.
 */

export interface PlanEntry {
  id: string;
  rule: string;
  scope: string;
  applicability: string;
}

export interface AgentSimulation {
  agent: AgentId;
  capabilities: AgentCapabilities;
  task: string;
  repo: { id: string; name: string; identity: string } | null;
  runtimeSupported: boolean;
  /** The exact native runtime output that would be injected, or null (no runtime channel). */
  block: string | null;
  /** True when a non-empty runtime block would be injected. */
  wouldInject: boolean;
  /** Preferences that would be injected at runtime (after static/runtime dedup). */
  preferences: RetrievedPreference[];
  overridden: RetrievalResult["overridden"];
  runtimeContext: RuntimeContextView;
  conditionalEvaluations: ConditionalEvaluation[];
  /** The delivery partition over this repo's active candidates, by preference. */
  plan: { static: PlanEntry[]; runtime: PlanEntry[]; unsupported: PlanEntry[] };
  environments: { name: string; scope: string; riskLevel: string; available: boolean; variableNames: string[] }[];
}

export interface SimulateOptions {
  agent?: AgentId;
  cwd: string;
  task: string;
  files?: string[];
  languages?: string[];
  domain?: string | null;
}

function emptyRuntimeContext(
  cwd: string,
  repo: { id: string; name: string; identity: string } | null,
): RuntimeContextView {
  return { cwd, repo, task: null, files: [], languages: [], domain: null };
}

export function simulateAgent(ctx: CtxContext, opts: SimulateOptions): AgentSimulation {
  const agent = opts.agent ?? "claude";
  const capabilities = capabilitiesFor(agent);
  const task = (opts.task ?? "").toString();

  // Active candidates for THIS repo (+ global) — the set the delivery planner
  // partitions. Resolve the repo read-only (a simulation never registers).
  const repo = ctx.repos.resolveReadOnly(opts.cwd);
  const active = ctx.preferences
    .list()
    .filter((p) => p.status === "approved" || p.status === "locked")
    .filter((p) => p.scope === "global" || (p.scope === "repo" && repo != null && p.repoId === repo.id));
  const byId = new Map(active.map((p) => [p.id, p]));
  const toEntries = (ids: string[]): PlanEntry[] =>
    ids
      .map((id) => byId.get(id))
      .filter((p): p is NonNullable<typeof p> => p != null)
      .map((p) => ({ id: p.id, rule: p.rule, scope: p.scope, applicability: p.applicability }));
  const rawPlan = planDelivery(capabilities, active);
  const plan = {
    static: toEntries(rawPlan.static),
    runtime: toEntries(rawPlan.runtime),
    unsupported: toEntries(rawPlan.unsupported),
  };

  // Empty task mirrors the live hook: nothing is injected at runtime.
  if (!task.trim()) {
    const repoView = repo ? { id: repo.id, name: repo.name, identity: repo.identity } : null;
    return {
      agent,
      capabilities,
      task,
      repo: repoView,
      runtimeSupported: capabilities.runtimePromptInjection,
      block: null,
      wouldInject: false,
      preferences: [],
      overridden: [],
      runtimeContext: buildRuntimeContextView(opts, repo ?? null),
      conditionalEvaluations: [],
      plan,
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

  let preferences: RetrievedPreference[] = [];
  let block: string | null = null;
  if (capabilities.runtimePromptInjection) {
    // Capability-driven static/runtime dedup, identical to the live hook.
    const staticIds = new Set(planDelivery(capabilities, result.preferences).static);
    preferences = result.preferences.filter((p) => !staticIds.has(p.id));
    block = renderContextBlock({ ...result, preferences });
  }

  return {
    agent,
    capabilities,
    task,
    repo: result.repo,
    runtimeSupported: capabilities.runtimePromptInjection,
    block,
    wouldInject: block !== null,
    preferences,
    overridden: result.overridden,
    runtimeContext: result.runtimeContext ?? emptyRuntimeContext(opts.cwd, result.repo),
    conditionalEvaluations: result.conditionalEvaluations ?? [],
    plan,
    environments: result.environments.map((e) => ({
      name: e.name,
      scope: e.scope,
      riskLevel: e.riskLevel,
      available: e.available,
      variableNames: e.variableNames,
    })),
  };
}

function buildRuntimeContextView(opts: SimulateOptions, repo: Repo | null): RuntimeContextView {
  const rc = buildRuntimeContext({
    cwd: opts.cwd,
    repo,
    task: null,
    files: opts.files,
    languages: opts.languages,
    domain: opts.domain,
  });
  return {
    cwd: rc.cwd,
    repo: rc.repo,
    task: rc.task,
    files: rc.files,
    languages: [...rc.languages].sort(),
    domain: rc.domain,
  };
}
