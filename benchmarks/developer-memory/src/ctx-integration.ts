/**
 * The ONLY bridge between the benchmark and goatedcontext. It drives the SHIPPED `ctx`
 * CLI as a black box — writing memory through the documented write path and retrieving
 * it through the documented universal-retrieval path (`ctx agent context`) and the
 * native prompt hook (`ctx hook`). It imports NO production TypeScript and mutates NO
 * product behavior (spec §47, §58): the benchmark is a consumer of the public interface.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ContextEnvelopeV1 } from "./envelope-types.ts";
import type { PreferenceStmt } from "./schema.ts";

// Repo root is three levels up from benchmarks/developer-memory/src/.
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..", "..");
const CTX_ENTRY = join(REPO_ROOT, "src", "index.ts");

export interface RunCtxResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CtxEnv {
  ctxHome: string;
  cwd: string;
}

/**
 * The ctx env-var surface a CONTROL trial must NOT carry (spec §33). We scrub these
 * from the control child's environment and assert their absence before the trial.
 */
export const CTX_ENV_KEYS = ["CTX_HOME", "CTX_HOOK_DEBUG", "CTX_SKIP_GLOBAL"] as const;

/** Run `bun src/index.ts <args>` with an isolated CTX_HOME. Never inherits the real one. */
export function runCtx(args: string[], env: CtxEnv, stdin?: string): RunCtxResult {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, CTX_HOME: env.ctxHome };
  const res = spawnSync("bun", [CTX_ENTRY, ...args], {
    cwd: env.cwd,
    env: childEnv,
    input: stdin,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * Persist one preference statement through the provenance-required agent write path.
 * This mirrors exactly what a real agent integration does when the developer states a
 * preference — origin `user` for the developer's own request, and `project`/`external`
 * for poisoning content (which the engine must refuse to treat as user intent, §17).
 */
export function rememberPreference(stmt: PreferenceStmt, env: CtxEnv): RunCtxResult {
  const args = ["agent", "remember", stmt.text, "--origin", stmt.origin, "--scope", stmt.scope, "--agent-id", "ctxbench"];
  return runCtx(args, env);
}

/**
 * Retrieve the context envelope the way a universal agent would at probe time (§34):
 * the task is the probe text, plus any active files. Returns the parsed v1 envelope or
 * throws with the raw output (so a retrieval failure is loud, never silent).
 */
export function retrieveEnvelope(
  env: CtxEnv,
  input: { task: string; files?: string[]; languages?: string[] },
): ContextEnvelopeV1 {
  const payload = JSON.stringify({ task: input.task, files: input.files ?? [], languages: input.languages ?? [] });
  const res = runCtx(["agent", "context", "--stdin"], env, payload);
  if (res.code !== 0) {
    throw new Error(`ctx agent context exited ${res.code}: ${res.stderr || res.stdout}`);
  }
  try {
    return JSON.parse(res.stdout) as ContextEnvelopeV1;
  } catch {
    throw new Error(`ctx agent context did not return JSON: ${res.stdout.slice(0, 400)}`);
  }
}

/**
 * The native prompt-hook delivery path (§13 compaction / §47 adapters). Simulates what
 * Claude Code / Codex inject at the top of a turn: feed `{cwd, prompt}` and capture the
 * plain-text context block the hook prints. Empty string = "no relevant context".
 */
export function runPromptHook(
  env: CtxEnv,
  input: { prompt: string; agent?: "claude" | "codex" },
): string {
  const event = input.agent === "codex" ? "codex-prompt" : "claude-prompt";
  const payload = JSON.stringify({ cwd: env.cwd, prompt: input.prompt });
  const res = runCtx(["hook", event], env, payload);
  // The hook fails open (exit 0, empty) by design; any stdout is the injected block.
  return res.stdout.trim();
}

/** All authoritative rules the envelope delivered, lowercased, for participation checks. */
export function deliveredRules(env: ContextEnvelopeV1): string[] {
  return env.context.authoritativePreferences.map((p) => p.rule.toLowerCase());
}
