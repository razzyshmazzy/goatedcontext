import { rmSync } from "node:fs";
import { CtxContext } from "../../src/core/context.ts";
import { openMemoryDatabase } from "../../src/storage/sqlite/db.ts";
import { FileSecretStore } from "../../src/storage/secrets/file-backend.ts";
import { resolvePaths } from "../../src/storage/paths.ts";
import type { Config } from "../../src/storage/config.ts";
import { normalizeEvent, type AgentEvent } from "../../src/core/overseer/event.ts";
import { extractFeatures } from "../../src/core/overseer/features.ts";
import { Overseer, type OverseerConfig } from "../../src/core/overseer/overseer.ts";
import type { ActivationSpec } from "../../src/core/overseer/activation.ts";
import { GOLD_MEMORIES } from "./gold-specs.ts";
import { TRAJECTORIES, type ScenarioEvent, type Trajectory } from "./scenarios.ts";
import type { BaselineRun, DeliveryRecord, TrajectoryRun } from "./score.ts";

const RULE_TO_ID = new Map(GOLD_MEMORIES.map((m) => [m.rule, m.id]));

/** Approx rendered size of one delivered memory (mirrors the overseer renderer). */
function renderedChars(rule: string): number {
  return Math.min(rule.length, 500) + 12;
}

/** Turn a scenario event into a normalized AgentEvent. */
function toEvent(sessionId: string, seq: number, e: ScenarioEvent): AgentEvent {
  return normalizeEvent({
    host: "claude",
    sessionId,
    seq,
    phase: e.phase,
    tool: e.tool,
    files: e.files,
    command: e.command,
    text: e.text,
  });
}

export function eventsFor(t: Trajectory): AgentEvent[] {
  return t.events.map((e, i) => toEvent(t.id, i, e));
}

// ---- baselines C/D/E: the deterministic overseer ------------------------

export interface DatasetRow {
  trajectory: string;
  seq: number;
  prefId: string;
  prefFeatures: string[];
  eventFeatures: string[];
  expectedRelevance: 0 | 1;
  expectedConflict: 0 | 1;
}

/** Flatten an activation spec into sparse "dim:value" feature strings. */
export function specFeatures(spec: ActivationSpec): string[] {
  const out: string[] = [];
  for (const d of spec.domains ?? []) out.push(`domain:${d}`);
  for (const o of spec.operations ?? []) out.push(`op:${o}`);
  for (const e of spec.executables ?? []) out.push(`exe:${e}`);
  for (const a of spec.artifacts ?? []) out.push(`artifact:${a}`);
  for (const p of spec.packages ?? []) out.push(`pkg:${p}`);
  for (const l of spec.languages ?? []) out.push(`lang:${l}`);
  for (const f of spec.files ?? []) out.push(`file:${f}`);
  if (spec.conflicts?.length) out.push("has:conflict");
  return out;
}

export function runOverseerBaseline(
  name: string,
  config: Partial<OverseerConfig>,
  opts: { collectDataset?: boolean } = {},
): { run: BaselineRun; dataset: DatasetRow[] } {
  const runs: TrajectoryRun[] = [];
  const dataset: DatasetRow[] = [];
  const specById = new Map(GOLD_MEMORIES.map((m) => [m.id, m.spec]));

  for (const t of TRAJECTORIES) {
    const overseer = new Overseer(GOLD_MEMORIES, { config });
    const deliveries: DeliveryRecord[] = [];
    const candidateCounts: number[] = [];
    const candidateIdsPerEvent: string[][] = [];
    const latenciesMs: number[] = [];
    const expRel = new Map(t.expect.filter((e) => e.relevantAt !== undefined).map((e) => [e.id, e.relevantAt!]));
    const expCon = new Map(t.expect.filter((e) => e.conflictAt !== undefined).map((e) => [e.id, e.conflictAt!]));

    const events = eventsFor(t);
    for (const ev of events) {
      const obs = overseer.observe(ev);
      for (const d of obs.deliveries) {
        deliveries.push({ seq: obs.seq, id: d.id, state: d.state === "conflict" ? "conflict" : "relevant", renderedChars: d.renderedChars });
      }
      candidateCounts.push(obs.candidateCount);
      candidateIdsPerEvent.push(obs.candidates);
      latenciesMs.push(obs.elapsedMs);

      if (opts.collectDataset) {
        const feats = extractFeatures(ev);
        const eventFeatures = [...feats.tags].sort();
        for (const id of obs.candidates) {
          const spec = specById.get(id);
          if (!spec) continue;
          const relAt = expRel.get(id);
          const conAt = expCon.get(id);
          const expectedConflict = conAt !== undefined && obs.seq >= conAt ? 1 : 0;
          const expectedRelevance =
            expectedConflict || (relAt !== undefined && obs.seq >= relAt) ? 1 : 0;
          dataset.push({
            trajectory: t.id,
            seq: obs.seq,
            prefId: id,
            prefFeatures: specFeatures(spec),
            eventFeatures,
            expectedRelevance: expectedRelevance as 0 | 1,
            expectedConflict: expectedConflict as 0 | 1,
          });
        }
      }
    }
    runs.push({ trajectoryId: t.id, deliveries, candidateCounts, candidateIdsPerEvent, latenciesMs });
  }
  return { run: { name, runs }, dataset };
}

// ---- baselines A/B: the real prompt-time retrieval engine ----------------

export interface SeededCtx {
  ctx: CtxContext;
  cleanup: () => void;
}

export function seedCtx(): SeededCtx {
  const dir = resolvePaths({ CTX_HOME: `${process.cwd()}/benchmarks/results/.overseer-seed-${process.pid}` }).home;
  const paths = resolvePaths({ CTX_HOME: dir });
  const db = openMemoryDatabase();
  const secrets = new FileSecretStore(paths.secretsFile, paths.secretKeyFile);
  const config: Config = { version: 1, createdAt: "2026-01-01T00:00:00.000Z", retrievalLimit: 12 };
  const ctx = CtxContext.fromParts(paths, config, db, secrets);
  // The preference schema speaks the CLASSIFIER domain vocabulary (ui-framework),
  // while overseer specs use the canonical signal vocabulary (frontend). Map the one
  // divergent token so baseline A keeps its domain signal; everything else matches.
  const prefDomain = (d: string | null | undefined): string | undefined => {
    if (!d) return undefined;
    return d === "frontend" ? "ui-framework" : d;
  };
  for (const m of GOLD_MEMORIES) {
    ctx.preferences.remember({
      rule: m.rule,
      scope: "global",
      status: "approved",
      applicability: "relevant",
      domain: prefDomain(m.domain),
      origin: "user",
    });
  }
  return {
    ctx,
    cleanup: () => {
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

function retrievedIds(ctx: CtxContext, task: string): string[] {
  const result = ctx.retrieval.retrieve({ cwd: process.cwd(), task, track: false });
  const ids: string[] = [];
  for (const p of result.preferences) {
    const id = RULE_TO_ID.get(p.rule);
    if (id) ids.push(id);
  }
  return ids;
}

/** Baseline A — prompt-only ctx retrieval (one query per trajectory). */
export function runPromptOnly(ctx: CtxContext): BaselineRun {
  const runs: TrajectoryRun[] = [];
  for (const t of TRAJECTORIES) {
    const deliveries: DeliveryRecord[] = [];
    for (const id of retrievedIds(ctx, t.prompt)) {
      const mem = GOLD_MEMORIES.find((m) => m.id === id)!;
      deliveries.push({ seq: -1, id, state: "relevant", renderedChars: renderedChars(mem.rule) });
    }
    runs.push({ trajectoryId: t.id, deliveries, candidateCounts: [], candidateIdsPerEvent: [], latenciesMs: [] });
  }
  return { name: "A: prompt-only retrieval", runs };
}

/** A lexical "task" string synthesized from one event (baseline B). */
function eventTask(e: ScenarioEvent): string {
  const parts: string[] = [];
  if (e.command?.executable) parts.push(e.command.executable);
  if (e.command?.argv) parts.push(e.command.argv.join(" "));
  for (const f of e.files ?? []) parts.push(f.path);
  if (e.text) parts.push(e.text);
  return parts.join(" ");
}

/** Baseline B — every-event ordinary lexical retrieval. */
export function runEveryEventLexical(ctx: CtxContext): BaselineRun {
  const runs: TrajectoryRun[] = [];
  for (const t of TRAJECTORIES) {
    const deliveries: DeliveryRecord[] = [];
    t.events.forEach((e, seq) => {
      const task = `${t.prompt} ${eventTask(e)}`.trim();
      for (const id of retrievedIds(ctx, task)) {
        const mem = GOLD_MEMORIES.find((m) => m.id === id)!;
        deliveries.push({ seq, id, state: "relevant", renderedChars: renderedChars(mem.rule) });
      }
    });
    runs.push({ trajectoryId: t.id, deliveries, candidateCounts: [], candidateIdsPerEvent: [], latenciesMs: [] });
  }
  return { name: "B: every-event lexical", runs };
}
