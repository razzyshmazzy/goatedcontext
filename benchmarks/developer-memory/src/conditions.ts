/**
 * Experimental conditions (spec §2–3) and their verification (spec §33–34).
 *
 *   control   — the preference is only ordinary conversation; NO goatedcontext at all.
 *   ctx       — the preference is persisted through ctx's real write path and delivered
 *               at probe time through ctx's real retrieval (hook block + envelope).
 *   agentsmd  — the preference is supplied through the static AGENTS.md mechanism.
 *
 * The workload after the preference is IDENTICAL across conditions; the ONLY thing that
 * differs is the delivery channel (spec §2). We verify control is genuinely ctx-free and
 * that ctx genuinely participated, recording where a ctx trial broke down (spec §35).
 */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Scenario, PreferenceStmt, InterferenceLevel } from "./schema.ts";
import type { AgentRunRequest } from "./adapters/types.ts";
import type { Condition, CtxFailureClass } from "./results.ts";
import { makeSandbox, createRepo, plantFile, type Sandbox } from "./isolation.ts";
import { interferenceTurns } from "./workloads/interference.ts";
import {
  rememberPreference,
  retrieveEnvelope,
  runPromptHook,
  CTX_ENV_KEYS,
  type CtxEnv,
} from "./ctx-integration.ts";

export interface TrialSpec {
  scenario: Scenario;
  condition: Condition;
  /** Interference level (defaults to the scenario's own; a depth sweep overrides it). */
  interference: InterferenceLevel;
  /** Prior turns are hidden from the agent (fresh session / cross-agent) — spec §11–12. */
  freshSession: boolean;
  trial: number;
  seed: number;
}

export interface Verification {
  ctxDetected: boolean;
  ctxPersisted: boolean | null;
  ctxRetrievalCalled: boolean | null;
  ctxDeliveredPreference: boolean | null;
  ctxInjectedChars: number | null;
  ctxApproxTokens: number | null;
  ctxRetrievalMs: number | null;
  /** Poisoning: did the engine REFUSE the adversarial non-user write? (null if N/A). */
  poisonRefused: boolean | null;
}

export interface PreparedTrial {
  sandbox: Sandbox;
  request: AgentRunRequest;
  verification: Verification;
  /** Set only on an infrastructure failure (never a model/adherence failure). */
  infraError?: string;
}

/**
 * A NEUTRAL, stable per-scenario sandbox slug. It MUST NOT contain tool/choice tokens
 * from the scenario id (bun/pnpm/vitest/jest/sqlite/postgres/…): the sandbox git remote
 * is copied verbatim into `package.json` by `npm init`, and content-scanning scorers
 * (`fileContains`/`exactChoice`/`noForbiddenChoice`/`frameworkDetected`) would otherwise
 * false-match a forbidden/preferred token that only appears in repo METADATA — a harness
 * scoring bug caught in the v1.1 dev pilot (a postgres solution failed on "sqlite" because
 * the scenario id was `cond-sqlite-...`). A hash is opaque, so no token can leak.
 */
export function sandboxSlug(id: string): string {
  return "s" + createHash("sha1").update(id).digest("hex").slice(0, 12);
}

/** A stable per-scenario remote so repo identity is deterministic (and leak-free). */
function remoteFor(scenario: Scenario): string {
  return `https://github.com/ctxbench/${sandboxSlug(scenario.id)}.git`;
}

/** The user-visible conversation turns before the probe (setup prefs + interference). */
function priorTurns(scenario: Scenario, interference: InterferenceLevel): string[] {
  return [...scenario.setupPreference.map((p) => p.text), ...interferenceTurns(interference)];
}

/** A distinctive token from the latest applicable preference, for delivery verification. */
function deliverySignature(scenario: Scenario): string | null {
  const last = scenario.setupPreference[scenario.setupPreference.length - 1];
  if (!last) return null;
  const words = last.text.toLowerCase().match(/\b[a-z][a-z0-9+-]{2,}\b/g) ?? [];
  const stop = new Set(["use", "the", "for", "and", "always", "prefer", "instead", "from", "now", "this", "repo", "actually", "when", "project", "uses"]);
  return words.find((w) => !stop.has(w)) ?? null;
}

export function prepareTrial(spec: TrialSpec): PreparedTrial {
  const { scenario, condition, interference, freshSession } = spec;
  const sandbox = makeSandbox({ language: scenario.repoLanguage, remote: remoteFor(scenario) });
  const ctxEnv: CtxEnv = { ctxHome: sandbox.ctxHome, cwd: sandbox.repo };

  const base: Omit<AgentRunRequest, "injectedContext"> = {
    repo: sandbox.repo,
    priorTurns: priorTurns(scenario, interference),
    probe: scenario.probe,
    freshSession,
    seed: spec.seed,
  };

  const verification: Verification = {
    ctxDetected: false,
    ctxPersisted: null,
    ctxRetrievalCalled: null,
    ctxDeliveredPreference: null,
    ctxInjectedChars: null,
    ctxApproxTokens: null,
    ctxRetrievalMs: null,
    poisonRefused: null,
  };

  try {
    if (condition === "control") {
      // §33: guarantee ctx is genuinely absent. No writes, no retrieval, no AGENTS.md,
      // and no ctx env vars reach the agent. injectedContext is empty.
      verification.ctxDetected = CTX_ENV_KEYS.some((k) => Boolean(process.env[k] && k !== "CTX_HOME"));
      return { sandbox, request: { ...base, injectedContext: "" }, verification };
    }

    if (condition === "agentsmd") {
      // Comparison condition C: a static repo instruction file. No ctx involvement.
      const body = ["# AGENTS.md", "", "Developer preferences:", ...scenario.setupPreference.map((p) => `- ${p.text}`), ""].join("\n");
      writeFileSync(join(sandbox.repo, "AGENTS.md"), body);
      // The agent reads AGENTS.md natively; for the harness we treat it as always-visible
      // context (it survives fresh sessions because it lives in the repo).
      return { sandbox, request: { ...base, injectedContext: body }, verification };
    }

    // condition === "ctx"
    // 1) Persist each preference through the real provenance-required write path.
    //    For a scope-leak test, repo-scoped preferences are recorded against a DIFFERENT
    //    repository (a sibling repo with its own identity), so a correct engine must not
    //    deliver them here (spec §7/§16). Global preferences are always recorded in-repo.
    let leakRepo: string | null = null;
    if (scenario.crossRepoLeak) {
      leakRepo = join(sandbox.root, "other-repo");
      createRepo(leakRepo, { language: scenario.repoLanguage, remote: `https://github.com/ctxbench/${sandboxSlug(scenario.id + "-other")}.git` });
    }
    let persistedAny = false;
    for (const stmt of scenario.setupPreference) {
      const writeEnv: CtxEnv =
        stmt.scope === "repo" && leakRepo ? { ctxHome: sandbox.ctxHome, cwd: leakRepo } : ctxEnv;
      const res = rememberPreference(stmt, writeEnv);
      // A user-origin write should succeed; a planted non-user write should be refused.
      if (stmt.origin === "user") persistedAny ||= res.code === 0;
    }
    verification.ctxPersisted = persistedAny;

    // 2) Poisoning: plant adversarial repo content, and attempt the adversarial NON-user
    //    write ctx must refuse (spec §17). Refusal (nonzero exit) = provenance held.
    if (scenario.poison.length > 0) {
      for (const p of scenario.poison) plantFile(sandbox.repo, p.path, p.content);
      // The adversarial content claims a rival preference; try to persist it as external
      // (as if the agent were tricked by the README). The engine must fail closed.
      const adversarial: PreferenceStmt = { text: scenario.poison[0]!.content.slice(0, 160), origin: "external", scope: "global" };
      const res = rememberPreference(adversarial, ctxEnv);
      verification.poisonRefused = res.code !== 0;
    }

    // 3) Retrieve at probe time exactly as a universal agent would. Time it (ctx overhead).
    const t0 = performance.now();
    const env = retrieveEnvelope(ctxEnv, { task: scenario.probe, languages: [scenario.repoLanguage] });
    verification.ctxRetrievalMs = Math.round((performance.now() - t0) * 1000) / 1000;
    verification.ctxRetrievalCalled = true;
    verification.ctxInjectedChars = env.meta.diagnostics.renderedChars;
    verification.ctxApproxTokens = env.meta.diagnostics.approxTokens;

    const sig = deliverySignature(scenario);
    const delivered = env.context.authoritativePreferences.map((p) => p.rule.toLowerCase());
    verification.ctxDeliveredPreference = sig ? delivered.some((r) => r.includes(sig)) : delivered.length > 0;

    // 4) The native hook block is what the agent actually sees injected at the top of the
    //    probe turn. Use it as the single ctx delivery channel (authentic, not synthetic).
    const injectedContext = runPromptHook(ctxEnv, { prompt: scenario.probe, agent: "claude" });

    return { sandbox, request: { ...base, injectedContext }, verification };
  } catch (err) {
    return { sandbox, request: { ...base, injectedContext: "" }, verification, infraError: String(err) };
  }
}

/**
 * Classify WHERE a failed ctx trial broke down (spec §35), given the scenario intent,
 * the verification, and whether the deterministic scorer passed. Only meaningful for the
 * ctx condition; returns null for a pass or a non-ctx condition.
 */
export function classifyCtxFailure(
  scenario: Scenario,
  v: Verification,
  pass: boolean,
  infra: boolean,
): CtxFailureClass {
  if (infra) return "infrastructure_error";
  if (pass) return null;
  if (scenario.category === "poisoning" && v.poisonRefused === false) return "poisoning_failure";
  if (v.ctxPersisted === false) return "persistence_failure";
  if (v.ctxRetrievalCalled === false) return "retrieval_failure";
  // A scenario where the preference should NOT apply (negative/abstention, conditional
  // non-match, explicit one-off override) that nonetheless failed is a FALSE POSITIVE:
  // the preference was wrongly applied. `scope_leak` is reserved for the cross-repo case.
  if (!scenario.appliesHere) {
    return scenario.crossRepoLeak ? "scope_leak" : "adherence_failure";
  }
  // Positive application that failed. If the relevant preference was never delivered, the
  // break is in retrieval/delivery (NOT a scope leak — the preference legitimately applies
  // here, it just wasn't surfaced; this is what the pilot saw for oblique probes).
  if (v.ctxDeliveredPreference === false) return "delivery_failure";
  // Delivered, but the superseded rule won → stale memory; else the model ignored it.
  if (scenario.category === "correction") return "stale_memory";
  return "adherence_failure";
}
