/**
 * Benchmark agent-adapter contract (spec §47).
 *
 * A benchmark adapter does FOUR things and nothing else: start a session, send prompts,
 * capture the resulting behavior (commands + files), and reset. It contains NO benchmark
 * scoring logic and NO goatedcontext logic — it is a thin driver around some coding agent
 * (a mock, Claude Code headless, Codex, a generic MCP/CLI agent). Keeping it this thin is
 * what lets us swap the agent under test without touching the harness (spec §47–49).
 */
import type { ObservedBehavior } from "../schema.ts";

export interface AgentRunRequest {
  /** Working directory the agent operates in (the sandbox repo). */
  repo: string;
  /**
   * Conversation turns BEFORE the probe, in order: the preference statement(s) followed
   * by the interference workload. In a fresh-session/cross-agent trial these are dropped
   * and ONLY `injectedContext` carries any surviving memory (spec §11–12).
   */
  priorTurns: string[];
  /**
   * Context delivered AT PROBE TIME by goatedcontext (the hook block / envelope text).
   * Empty string in the control condition. This is the single channel through which the
   * ctx condition is allowed to help — the probe wording is identical across conditions.
   */
  injectedContext: string;
  /** The probe prompt (a later task that implicitly needs the preference). */
  probe: string;
  /** True → prior turns are NOT in the agent's context (new session / different agent). */
  freshSession: boolean;
  /** Deterministic seed for any adapter-internal choices. */
  seed: number;
}

export interface AgentRunResult {
  /** What the agent did on the probe turn. The ONLY thing the scorer sees. */
  behavior: ObservedBehavior;
  /** False → this scenario/combination is not supported by this adapter (→ `unsupported`). */
  supported: boolean;
  /** Set on an infrastructure failure (→ `infrastructure_error`, never scored as a model fail). */
  error?: string;
  /** Path to the preserved raw transcript for manual review (spec §5, §54). */
  transcriptPath?: string;
  /** Adapter-reported run metadata (session id, cost, permission denials, …) for review. */
  meta?: {
    sessionId?: string | null;
    costUsd?: number | null;
    permissionDenials?: number | null;
    numTurns?: number | null;
    isError?: boolean | null;
    /** The exact prompt text the agent received — lets fresh-session purity be proven (§9). */
    composedPrompt?: string;
  };
}

export interface AgentAdapter {
  readonly id: string;
  /** Exact version string recorded in the manifest (spec §25). */
  version(): Promise<string> | string;
  /** Whether this adapter can actually run here (binary present, authenticated, etc.). */
  available(): Promise<boolean> | boolean;
  /** Which experimental conditions this adapter can honor. */
  readonly capabilities: { freshSession: boolean; compaction: boolean };
  run(req: AgentRunRequest): Promise<AgentRunResult>;
}
