import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sanitizeInjectedText } from "../render/context-block.ts";
import { ActivationSpecSchema } from "./activation.ts";
import { type AgentEvent, AgentEventSchema } from "./event.ts";
import { type Delivery, Overseer, type OverseerConfig, type OverseerObservation, type ActivatedMemory } from "./overseer.ts";
import { OPERATIONS } from "./vocab.ts";

/**
 * V1 runtime glue for the overseer (§4): hook → `ctx event` → evaluate → maybe emit
 * → exit. NO daemon, NO sockets. Per-session state is a tiny JSON file under the ctx
 * home holding a BOUNDED window of recent normalized events plus a seq counter. Each
 * invocation appends the new event and REPLAYS the window through a fresh Overseer —
 * deterministic, serialization-free, and cheap enough to measure. The replay window
 * bounds how far back ledger suppression and decay remember (a deliberate tradeoff
 * for a process-per-event model).
 */

/** How many recent events to retain + replay per session. */
export const REPLAY_WINDOW = 64;

const TemporalSchema = z
  .object({ triggerOps: z.array(z.enum(OPERATIONS)), satisfyOps: z.array(z.enum(OPERATIONS)) })
  .strict();

const ActivatedMemorySchema = z
  .object({
    id: z.string().min(1),
    rule: z.string().min(1),
    domain: z.string().nullable().optional(),
    scope: z.enum(["global", "repo"]).optional(),
    repo: z.string().nullable().optional(),
    spec: ActivationSpecSchema,
    temporal: TemporalSchema.optional(),
  })
  .strict();

export const SpecsFileSchema = z.object({ memories: z.array(ActivatedMemorySchema) }).strict();

interface SessionState {
  nextSeq: number;
  events: AgentEvent[];
}

/** Resolve the overseer state directory, creating it on demand. */
export function overseerDir(home: string): string {
  const dir = join(home, "overseer");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** The default sidecar specs path (CTX_OVERSEER_SPECS overrides). */
export function defaultSpecsPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CTX_OVERSEER_SPECS?.trim();
  return override && override.length ? override : join(home, "overseer-specs.json");
}

/** Load + validate the sidecar activation specs. Returns [] when absent/invalid. */
export function loadSpecs(path: string): ActivatedMemory[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = SpecsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.memories as ActivatedMemory[];
  } catch {
    return [];
  }
}

function sessionFile(home: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128) || "unknown";
  return join(overseerDir(home), `${safe}.json`);
}

function loadSession(home: string, sessionId: string): SessionState {
  const file = sessionFile(home, sessionId);
  if (!existsSync(file)) return { nextSeq: 0, events: [] };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { nextSeq?: number; events?: unknown[] };
    const events = (raw.events ?? [])
      .map((e) => AgentEventSchema.safeParse(e))
      .filter((r) => r.success)
      .map((r) => (r as { data: AgentEvent }).data);
    return { nextSeq: typeof raw.nextSeq === "number" ? raw.nextSeq : events.length, events };
  } catch {
    return { nextSeq: 0, events: [] };
  }
}

function saveSession(home: string, sessionId: string, state: SessionState): void {
  const file = sessionFile(home, sessionId);
  const trimmed = state.events.slice(-REPLAY_WINDOW);
  writeFileSync(file, JSON.stringify({ nextSeq: state.nextSeq, events: trimmed }), "utf8");
}

export interface RunEventResult {
  block: string | null;
  observation: OverseerObservation | null;
  deliveries: Delivery[];
  latencyMs: number;
  specCount: number;
}

/**
 * Append a normalized event to its session window, replay the window, and compute
 * the overseer deliveries for THIS event. Pure wrt the DB — reads no preferences;
 * only the sidecar specs + session window.
 */
export function runEvent(
  home: string,
  event: AgentEvent,
  opts: { specs?: ActivatedMemory[]; config?: Partial<OverseerConfig>; currentRepo?: string | null } = {},
): RunEventResult {
  const start = performance.now();
  const specs = opts.specs ?? loadSpecs(defaultSpecsPath(home));
  const state = loadSession(home, event.sessionId);
  const normalized: AgentEvent = { ...event, seq: state.nextSeq };
  const events = [...state.events, normalized];
  saveSession(home, event.sessionId, { nextSeq: state.nextSeq + 1, events });

  if (specs.length === 0) {
    return { block: null, observation: null, deliveries: [], latencyMs: performance.now() - start, specCount: 0 };
  }

  const overseer = new Overseer(specs, { config: opts.config, currentRepo: opts.currentRepo ?? event.repo ?? null });
  const window = events.slice(-REPLAY_WINDOW);
  let last: OverseerObservation | null = null;
  for (const e of window) last = overseer.observe(e);

  const deliveries = last?.deliveries ?? [];
  const block = renderOverseerBlock(deliveries);
  return { block, observation: last, deliveries, latencyMs: performance.now() - start, specCount: specs.length };
}

/**
 * Render deliveries into a compact injected block, wrapped in distinct
 * `<ctx-overseer-context>` tags so the agent can tell event-activated context apart
 * from prompt-time retrieval. Returns null when there is nothing to deliver.
 */
export function renderOverseerBlock(deliveries: Delivery[]): string | null {
  if (deliveries.length === 0) return null;
  const lines: string[] = [];
  lines.push("<ctx-overseer-context>");
  lines.push(
    "Your recent actions activated stored developer preferences below. These are authoritative preferences, surfaced now because this step made them relevant — apply them before continuing.",
  );
  const conflicts = deliveries.filter((d) => d.state === "conflict");
  const relevant = deliveries.filter((d) => d.state !== "conflict");
  if (conflicts.length) {
    lines.push("CONFLICT — your current action appears to contradict a standing preference:");
    for (const d of conflicts) lines.push(`- ${sanitizeInjectedText(d.rule)}`);
  }
  if (relevant.length) {
    lines.push("Newly relevant preferences:");
    for (const d of relevant) lines.push(`- ${sanitizeInjectedText(d.rule)}`);
  }
  lines.push("</ctx-overseer-context>");
  return lines.join("\n");
}
