import type { AgentCapabilities } from "./capabilities.ts";

/**
 * The pure delivery planner (0.2.9).
 *
 * Given an agent's capabilities and a set of preferences, it partitions preference
 * IDs into exactly three buckets — `static`, `runtime`, `unsupported` — according
 * to one policy, shared by every consumer (the static AGENTS.md materializer, the
 * runtime hook dedup, `ctx agents`, `ctx test-hook`). Partitioning is by **ID**, so
 * static/runtime deduplication never relies on comparing formatted strings.
 *
 * Policy:
 *   - a `repo` + (`approved`|`locked`) + `always` preference is STATIC when the
 *     agent reads AGENTS.md; otherwise runtime (if it injects) else unsupported;
 *   - every other active preference (global `always`, any `relevant`, any
 *     `conditional`) is RUNTIME when the agent injects at prompt time, otherwise
 *     UNSUPPORTED — it is NEVER silently broadened into a static always-on rule;
 *   - non-active preferences (proposed/observed/rejected) are excluded entirely.
 *
 * An ID appears in at most one bucket, so a preference is never delivered both
 * statically and at runtime to the same agent.
 */

/** The minimal preference shape the planner needs (both Preference and the
 * retrieval result row satisfy it). */
export interface DeliverablePref {
  id: string;
  scope: string;
  status: string;
  applicability: string;
}

export interface DeliveryPlan {
  /** Delivered via the static AGENTS.md projection. */
  static: string[];
  /** Delivered at prompt time via the runtime hook. */
  runtime: string[];
  /** Cannot be delivered to this agent (no mechanism) — honestly reported, never broadened. */
  unsupported: string[];
}

const ACTIVE = new Set(["approved", "locked"]);

type Dest = "static" | "runtime" | "unsupported";

function destinationOf(p: DeliverablePref, caps: AgentCapabilities): Dest {
  const repoAlways = p.scope === "repo" && p.applicability === "always";
  if (repoAlways) {
    if (caps.staticAgentsMd) return "static";
    if (caps.runtimePromptInjection) return "runtime";
    return "unsupported";
  }
  // global always, relevant (any scope), conditional (any scope).
  return caps.runtimePromptInjection ? "runtime" : "unsupported";
}

export function planDelivery(caps: AgentCapabilities, prefs: DeliverablePref[]): DeliveryPlan {
  const plan: DeliveryPlan = { static: [], runtime: [], unsupported: [] };
  for (const p of prefs) {
    if (!ACTIVE.has(p.status)) continue; // proposed/observed/rejected never materialize
    plan[destinationOf(p, caps)].push(p.id);
  }
  return plan;
}
