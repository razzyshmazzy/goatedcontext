import type { CtxContext } from "../../core/context.ts";
import { simulateAgent, type AgentSimulation } from "../test-hook.ts";

/**
 * Backward-compatible Claude dry run. 0.2.9 generalized the simulator to every
 * agent (`simulateAgent`); this keeps the historical Claude-only entry point so
 * existing callers/tests are unchanged. It is exactly `simulateAgent` with
 * `agent: "claude"`.
 */
export type TestHookResult = AgentSimulation;

export function simulateHook(ctx: CtxContext, opts: { cwd: string; task: string }): TestHookResult {
  return simulateAgent(ctx, { agent: "claude", cwd: opts.cwd, task: opts.task });
}
