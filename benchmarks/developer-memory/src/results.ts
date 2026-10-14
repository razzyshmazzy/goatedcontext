/**
 * Raw result storage, resume, and crash safety (spec §28, §31).
 *
 * Layout per run (spec §28):
 *   benchmarks/results/<run-id>/
 *     manifest.json      environment + config (written once, up front)
 *     trials.jsonl       one record per completed trial (append-only, atomic)
 *     summary.json       computed metrics (rewritten at the end, never mid-run)
 *     failures/          representative failure artifacts
 *
 * Append-only trials.jsonl is the source of truth. Resume reads it, builds the set of
 * completed trial KEYS, and skips them (spec §31). We never rewrite an existing record.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Category, InterferenceLevel } from "./schema.ts";

/** How a trial ended (spec §32, §35): model outcomes vs infra are never conflated. */
export type Outcome = "pass" | "fail" | "infrastructure_error" | "unsupported";

/** ctx failure taxonomy — WHERE a ctx trial broke down (spec §35). */
export type CtxFailureClass =
  | "capture_failure"
  | "persistence_failure"
  | "retrieval_failure"
  | "delivery_failure"
  | "adherence_failure"
  | "stale_memory"
  | "scope_leak"
  | "poisoning_failure"
  | "infrastructure_error"
  | null;

export type Condition = "control" | "ctx" | "agentsmd";

export interface TrialRecord {
  scenarioId: string;
  category: Category;
  split: "dev" | "heldout";
  condition: Condition;
  sourceAgent: string;
  destinationAgent: string;
  trial: number;
  /** True → this trial dropped the prior conversation (fresh session / cross-agent). */
  freshSession: boolean;
  interference: InterferenceLevel;
  probe: string;
  expected: string;
  forbidden: string;
  appliesHere: boolean;

  outcome: Outcome;
  /** For pass/fail: the deterministic scorer's verdict. */
  pass: boolean;
  scoreReason: string;
  ctxFailureClass: CtxFailureClass;

  /** Condition verification (spec §33–34). */
  ctxDetected: boolean; // control MUST be false
  ctxPersisted: boolean | null; // ctx condition: did the write land?
  ctxRetrievalCalled: boolean | null;
  ctxDeliveredPreference: boolean | null; // did the relevant rule reach the agent?
  poisonRefused: boolean | null; // poisoning: was the adversarial non-user write refused?

  /** Context-cost + latency instrumentation (spec §38–39). */
  ctxInjectedChars: number | null;
  ctxApproxTokens: number | null;
  ctxRetrievalMs: number | null;

  /** Forensics (spec §54): raw artifact pointers, sanitized. */
  artifactPath: string | null;
  /** Raw agent transcript path (real-agent runs) for manual review (spec §5, §12). */
  transcriptPath: string | null;
  /** Agent session id — unique per invocation; used to prove fresh sessions (spec §9). */
  agentSessionId: string | null;
  /** Agent-reported cost in USD, when available. */
  costUsd: number | null;
  /** Count of permission denials the agent hit (should be 0 under bypassPermissions). */
  permissionDenials: number | null;
  errors: string[];
  /** Deterministic seed used to build this trial's sandbox/order (spec §26). */
  seed: number;
  /** ISO timestamp, injected by the caller (scripts have no clock of their own). */
  at: string;
}

/** The unique key that makes a trial idempotent for resume (spec §31). */
export function trialKey(
  r: Pick<TrialRecord, "scenarioId" | "condition" | "sourceAgent" | "destinationAgent" | "trial" | "freshSession">,
): string {
  return [r.scenarioId, r.condition, r.sourceAgent, r.destinationAgent, r.freshSession ? "fresh" : "same", r.trial].join("::");
}

export class ResultStore {
  readonly dir: string;
  readonly trialsFile: string;
  readonly failuresDir: string;
  private completed = new Set<string>();

  constructor(resultsRoot: string, runId: string) {
    this.dir = join(resultsRoot, runId);
    this.trialsFile = join(this.dir, "trials.jsonl");
    this.failuresDir = join(this.dir, "failures");
    mkdirSync(this.failuresDir, { recursive: true });
    if (existsSync(this.trialsFile)) this.loadCompleted();
  }

  private loadCompleted(): void {
    const text = readFileSync(this.trialsFile, "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const rec = JSON.parse(line) as TrialRecord;
        // Infra errors are NOT counted as completed, so a resume retries them (spec §31/§32).
        if (rec.outcome !== "infrastructure_error") this.completed.add(trialKey(rec));
      } catch {
        /* a torn final line from a crash is ignored; append-only means prior lines are intact */
      }
    }
  }

  isCompleted(key: string): boolean {
    return this.completed.has(key);
  }

  /** Append one record atomically (one write syscall; newline-terminated JSON). */
  record(rec: TrialRecord): void {
    appendFileSync(this.trialsFile, JSON.stringify(rec) + "\n");
    if (rec.outcome !== "infrastructure_error") this.completed.add(trialKey(rec));
  }

  readAll(): TrialRecord[] {
    if (!existsSync(this.trialsFile)) return [];
    return readFileSync(this.trialsFile, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TrialRecord);
  }

  /** Write the manifest once, up front (spec §50). Refuses to clobber an existing one. */
  writeManifest(manifest: unknown): void {
    const file = join(this.dir, "manifest.json");
    if (existsSync(file)) return; // a resume keeps the original manifest
    writeFileSync(file, JSON.stringify(manifest, null, 2));
  }

  /** Rewrite summary.json atomically (temp + rename) only at the end of a run. */
  writeSummary(summary: unknown): void {
    const file = join(this.dir, "summary.json");
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(summary, null, 2));
    renameSync(tmp, file);
  }

  /** Persist a sanitized failure artifact (spec §28/§54). Returns its path. */
  writeFailureArtifact(key: string, body: unknown): string {
    const safe = key.replace(/[^a-z0-9._-]+/gi, "_");
    const file = join(this.failuresDir, `${safe}.json`);
    writeFileSync(file, JSON.stringify(body, null, 2));
    return file;
  }
}
