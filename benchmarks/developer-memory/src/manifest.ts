/**
 * Run manifest (spec §50) — the provenance record every result directory carries.
 *
 * It pins everything needed to interpret and reproduce a run: benchmark version, a hash
 * of the frozen dataset (spec §60), the ctx git SHA + package version, agent/model
 * versions, OS/runtime, seed, date, and the exact enabled configuration. If the dataset
 * hash changes, the benchmark version MUST change — that is what prevents moving the
 * goalposts after seeing results (spec §51, §60).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { platform, release, arch } from "node:os";
import type { Scenario } from "./schema.ts";
import type { Condition } from "./results.ts";
import { REPO_ROOT } from "./ctx-integration.ts";

/** Frozen benchmark version. Bump on ANY change to scenarios/workloads/scoring (spec §60). */
export const BENCHMARK_VERSION = "developer-memory-v1.1";

function safeExec(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function ctxGitSha(): string {
  return safeExec("git", ["rev-parse", "HEAD"]);
}

function ctxPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

/**
 * A stable content hash of the scenario dataset. Canonicalizes each scenario to the
 * fields that affect behavior/scoring (ignoring presentation-only notes/titles) so an
 * accidental reword of a note does not look like a goalpost move, but any change to a
 * preference, probe, scorer, or interference does.
 */
export function datasetHash(scenarios: Scenario[]): string {
  const canonical = [...scenarios]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => ({
      id: s.id,
      category: s.category,
      split: s.split,
      setupPreference: s.setupPreference,
      repoLanguage: s.repoLanguage,
      interference: s.interference,
      probe: s.probe,
      appliesHere: s.appliesHere,
      scorer: s.scorer,
      poison: s.poison,
      sourceAgent: s.sourceAgent ?? null,
      destinationAgent: s.destinationAgent ?? null,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

export interface Manifest {
  benchmarkVersion: string;
  datasetHash: string;
  ctxGitSha: string;
  ctxPackageVersion: string;
  agent: { id: string; version: string; model: string };
  os: { platform: string; release: string; arch: string };
  runtime: { bun: string | null; node: string };
  seed: number;
  date: string;
  scenarioCount: number;
  trialsPerCell: number;
  conditions: Condition[];
  enabledCategories: string[];
  controlConfig: string;
  ctxConfig: string;
  deterministicScorers: boolean;
  runId: string;
}

export interface ManifestInput {
  scenarios: Scenario[];
  agent: { id: string; version: string; model: string };
  seed: number;
  date: string;
  trialsPerCell: number;
  conditions: Condition[];
  runId: string;
}

export function buildManifest(input: ManifestInput): Manifest {
  return {
    benchmarkVersion: BENCHMARK_VERSION,
    datasetHash: datasetHash(input.scenarios),
    ctxGitSha: ctxGitSha(),
    ctxPackageVersion: ctxPackageVersion(),
    agent: input.agent,
    os: { platform: platform(), release: release(), arch: arch() },
    runtime: { bun: (globalThis as any).Bun?.version ?? null, node: process.version },
    seed: input.seed,
    date: input.date,
    scenarioCount: input.scenarios.length,
    trialsPerCell: input.trialsPerCell,
    conditions: input.conditions,
    enabledCategories: [...new Set(input.scenarios.map((s) => s.category))],
    controlConfig: "no ctx hook/MCP/AGENTS.md/env/skill; conversation-only memory (spec §33)",
    ctxConfig: "ctx agent remember (provenance) + ctx hook/agent context retrieval (spec §34)",
    deterministicScorers: true,
    runId: input.runId,
  };
}
