/**
 * Trial orchestration (spec §26–35).
 *
 * Builds a flat, deterministic list of trial tasks (scenarios × conditions × agents ×
 * trials, plus optional fresh-session / depth-sweep variants), shuffles their ORDER with
 * a seeded PRNG so a condition is never always-first (spec §26), then runs each in full
 * isolation, scores it on BEHAVIOR, records it immediately (crash-safe), and skips any
 * trial already completed on a resume (spec §31). Model outcomes and infrastructure
 * errors are never conflated (spec §32).
 */
import type { Scenario, InterferenceLevel } from "./schema.ts";
import { score } from "./scorers.ts";
import {
  prepareTrial,
  classifyCtxFailure,
  type TrialSpec,
} from "./conditions.ts";
import type { AgentAdapter } from "./adapters/types.ts";
import {
  ResultStore,
  trialKey,
  type Condition,
  type TrialRecord,
  type Outcome,
} from "./results.ts";

/** Tiny deterministic PRNG (mulberry32), matching the repo's test-fixture convention. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], seed: number): T[] {
  const r = rng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface RunConfig {
  scenarios: Scenario[];
  conditions: Condition[];
  trials: number;
  seed: number;
  /** Also run a fresh-session variant of each trial (spec §11). */
  freshSession: boolean;
  /** Run the full interference depth sweep per scenario instead of its default (spec §15). */
  depthSweep: boolean;
  /** Safety cap on total trials actually executed (spec §30). */
  maxTrials?: number;
  /** ISO timestamp for records (scripts have no clock). */
  now: string;
}

interface TrialTask extends TrialSpec {
  freshSessionVariant: boolean;
}

const ALL_LEVELS: InterferenceLevel[] = ["none", "light", "medium", "heavy"];

function buildTasks(cfg: RunConfig): TrialTask[] {
  const tasks: TrialTask[] = [];
  for (const scenario of cfg.scenarios) {
    const levels = cfg.depthSweep ? ALL_LEVELS : [scenario.interference];
    const freshModes = cfg.freshSession ? [false, true] : [false];
    for (const condition of cfg.conditions) {
      for (const interference of levels) {
        for (const fresh of freshModes) {
          for (let t = 1; t <= cfg.trials; t++) {
            tasks.push({
              scenario,
              condition,
              interference,
              freshSession: fresh,
              freshSessionVariant: fresh,
              trial: t,
              // Per-trial seed derived from the run seed so sandboxes/order are reproducible.
              seed: cfg.seed + t,
            });
          }
        }
      }
    }
  }
  return shuffle(tasks, cfg.seed);
}

export interface PlanSummary {
  scenarios: number;
  conditions: Condition[];
  trialsPerCell: number;
  totalTasks: number;
  freshSession: boolean;
  depthSweep: boolean;
}

export function planSummary(cfg: RunConfig): PlanSummary {
  return {
    scenarios: cfg.scenarios.length,
    conditions: cfg.conditions,
    trialsPerCell: cfg.trials,
    totalTasks: buildTasks(cfg).length,
    freshSession: cfg.freshSession,
    depthSweep: cfg.depthSweep,
  };
}

export interface RunHooks {
  onTrial?: (rec: TrialRecord, index: number, total: number) => void;
}

/** Execute the run against ONE agent adapter, persisting as it goes. */
export async function runBenchmark(
  cfg: RunConfig,
  agent: AgentAdapter,
  store: ResultStore,
  hooks: RunHooks = {},
): Promise<TrialRecord[]> {
  const agentId = agent.id;
  let tasks = buildTasks(cfg);
  if (cfg.maxTrials != null) tasks = tasks.slice(0, cfg.maxTrials);

  const records: TrialRecord[] = [];
  let i = 0;
  for (const task of tasks) {
    i++;
    const { scenario } = task;
    const sourceAgent = scenario.sourceAgent ?? agentId;
    const destinationAgent = scenario.destinationAgent ?? agentId;
    const key = trialKey({ scenarioId: scenario.id, condition: task.condition, sourceAgent, destinationAgent, trial: task.trial, freshSession: task.freshSession });

    if (store.isCompleted(key)) continue;

    const rec = await runOne(task, agent, scenario, sourceAgent, destinationAgent, cfg.now);
    store.record(rec);
    records.push(rec);
    hooks.onTrial?.(rec, i, tasks.length);
  }
  return records;
}

async function runOne(
  task: TrialTask,
  agent: AgentAdapter,
  scenario: Scenario,
  sourceAgent: string,
  destinationAgent: string,
  now: string,
): Promise<TrialRecord> {
  const prepared = prepareTrial(task);
  try {
    // Fresh-session requested but the adapter cannot honor it → unsupported, not a fail.
    if (task.freshSession && !agent.capabilities.freshSession) {
      return baseRecord(task, scenario, sourceAgent, destinationAgent, now, prepared, {
        outcome: "unsupported",
        pass: false,
        scoreReason: "adapter does not support fresh sessions",
        ctxFailureClass: null,
      });
    }

    if (prepared.infraError) {
      return baseRecord(task, scenario, sourceAgent, destinationAgent, now, prepared, {
        outcome: "infrastructure_error",
        pass: false,
        scoreReason: prepared.infraError,
        ctxFailureClass: "infrastructure_error",
      });
    }

    const result = await agent.run(prepared.request);
    // Attach raw-transcript + agent metadata to EVERY record (even unsupported/error), so a
    // manual reviewer can always inspect what the real agent actually did (spec §4, §5, §12).
    const attach = (rec: TrialRecord): TrialRecord => {
      rec.transcriptPath = result.transcriptPath ?? null;
      rec.agentSessionId = result.meta?.sessionId ?? null;
      rec.costUsd = result.meta?.costUsd ?? null;
      rec.permissionDenials = result.meta?.permissionDenials ?? null;
      return rec;
    };

    if (!result.supported) {
      return attach(baseRecord(task, scenario, sourceAgent, destinationAgent, now, prepared, {
        outcome: "unsupported",
        pass: false,
        scoreReason: result.error ?? "adapter reported scenario unsupported",
        ctxFailureClass: null,
      }));
    }
    if (result.error) {
      return attach(baseRecord(task, scenario, sourceAgent, destinationAgent, now, prepared, {
        outcome: "infrastructure_error",
        pass: false,
        scoreReason: result.error,
        ctxFailureClass: "infrastructure_error",
      }));
    }

    const verdict = score(scenario.scorer, result.behavior);
    const ctxFailureClass =
      task.condition === "ctx"
        ? classifyCtxFailure(scenario, prepared.verification, verdict.pass, false)
        : null;

    const rec = attach(baseRecord(task, scenario, sourceAgent, destinationAgent, now, prepared, {
      outcome: verdict.pass ? "pass" : "fail",
      pass: verdict.pass,
      scoreReason: verdict.reason,
      ctxFailureClass,
    }));
    // Preserve a representative failure artifact (behavior + injected context) — sanitized.
    if (!verdict.pass) {
      rec.artifactPath = sanitizeArtifact(task, scenario, result.behavior, prepared.request.injectedContext);
    }
    return rec;
  } finally {
    prepared.sandbox.cleanup();
  }
}

function baseRecord(
  task: TrialTask,
  scenario: Scenario,
  sourceAgent: string,
  destinationAgent: string,
  now: string,
  prepared: ReturnType<typeof prepareTrial>,
  outcome: { outcome: Outcome; pass: boolean; scoreReason: string; ctxFailureClass: TrialRecord["ctxFailureClass"] },
): TrialRecord {
  const v = prepared.verification;
  return {
    scenarioId: scenario.id,
    category: scenario.category,
    split: scenario.split,
    condition: task.condition,
    sourceAgent,
    destinationAgent,
    trial: task.trial,
    freshSession: task.freshSession,
    interference: task.interference,
    probe: scenario.probe,
    expected: scenario.expectedBehavior,
    forbidden: scenario.forbiddenBehavior,
    appliesHere: scenario.appliesHere,
    outcome: outcome.outcome,
    pass: outcome.pass,
    scoreReason: outcome.scoreReason,
    ctxFailureClass: outcome.ctxFailureClass,
    ctxDetected: v.ctxDetected,
    ctxPersisted: v.ctxPersisted,
    ctxRetrievalCalled: v.ctxRetrievalCalled,
    ctxDeliveredPreference: v.ctxDeliveredPreference,
    poisonRefused: v.poisonRefused,
    ctxInjectedChars: v.ctxInjectedChars,
    ctxApproxTokens: v.ctxApproxTokens,
    ctxRetrievalMs: v.ctxRetrievalMs,
    artifactPath: null,
    transcriptPath: null,
    agentSessionId: null,
    costUsd: null,
    permissionDenials: null,
    errors: prepared.infraError ? [prepared.infraError] : [],
    seed: task.seed,
    at: now,
  };
}

// Store the sanitized artifact lazily; we only need the store's failuresDir, which the
// CLI wires up. To avoid a circular dep, the CLI passes a writer; here we just build the
// payload path marker and let the store persist it. Kept inline for the mock/offline path.
let artifactWriter: ((key: string, body: unknown) => string) | null = null;
export function setArtifactWriter(fn: (key: string, body: unknown) => string): void {
  artifactWriter = fn;
}
function sanitizeArtifact(task: TrialTask, scenario: Scenario, behavior: unknown, injected: string): string | null {
  if (!artifactWriter) return null;
  const key = `${scenario.id}__${task.condition}__t${task.trial}${task.freshSessionVariant ? "_fresh" : ""}`;
  return artifactWriter(key, {
    scenarioId: scenario.id,
    condition: task.condition,
    probe: scenario.probe,
    expected: scenario.expectedBehavior,
    forbidden: scenario.forbiddenBehavior,
    injectedContext: injected,
    behavior,
  });
}
