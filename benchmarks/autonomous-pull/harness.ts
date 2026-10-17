/**
 * Autonomous-pull benchmark harness.
 *
 * Drives the SHIPPED ctx CLI as a black box (same philosophy as the developer-memory
 * benchmark's ctx-integration): it seeds memory through the provenance-required write
 * path and retrieves through the universal `ctx agent context` contract. The optional
 * real-model pilot spawns Claude Code headless in an isolated sandbox and observes
 * whether the model autonomously invokes ctx. It imports NO production TypeScript
 * except the shared pull-policy asset (the exact standing instruction under test).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { renderPullGuidance } from "../../src/core/assets/retrieval-policy.ts";
import type { Scenario } from "./scenarios.ts";
import { ALL_SCENARIOS, RELEVANT, seedsFor } from "./scenarios.ts";
import type { DeterministicResult, PilotTrial } from "./score.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
const CTX_ENTRY = join(REPO_ROOT, "src", "index.ts");
const IS_WIN = process.platform === "win32";

export interface Sandbox {
  ctxHome: string;
  repo: string;
  /** A Claude `--settings` file that disables ALL hooks for the pilot, so the host's
   *  push hook never fires and we measure the PULL decision in isolation. `--settings`
   *  MERGES with user settings, so auth (OAuth/subscription) is preserved. */
  settingsFile: string;
  /** A bin dir holding a `ctx` shim that forwards to THIS working tree's CLI. Prepended
   *  to the pilot child's PATH so the model exercises the code under test, not whatever
   *  older `ctx` happens to be globally installed. */
  shimDir: string;
  cleanup: () => void;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `bun src/index.ts <args>` against an isolated CTX_HOME. Never the real one. */
export function runCtx(args: string[], ctxHome: string, cwd: string, stdin?: string): RunResult {
  const res = spawnSync("bun", [CTX_ENTRY, ...args], {
    cwd,
    env: { ...process.env, CTX_HOME: ctxHome },
    input: stdin,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Create an isolated CTX_HOME + git repo and seed every relevant preference once. */
export function setupSandbox(seedScenarios: Scenario[] = RELEVANT): Sandbox {
  const ctxHome = mkdtempSync(join(tmpdir(), "ctxpull-home-"));
  const repo = mkdtempSync(join(tmpdir(), "ctxpull-repo-"));
  const git = (a: string[]) => spawnSync("git", a, { cwd: repo, stdio: "ignore" });
  git(["init", "-q"]);
  git(["remote", "add", "origin", "https://github.com/acme/pull-bench.git"]);
  runCtx(["init"], ctxHome, repo);

  for (const { seed } of seedsFor(seedScenarios)) {
    const args = ["agent", "remember", seed.rule, "--origin", "user", "--scope", seed.scope, "--agent-id", "ctxpull"];
    if (seed.applicability === "always") args.push("--always");
    const r = runCtx(args, ctxHome, repo);
    if (r.code !== 0) throw new Error(`seed failed (${seed.rule}): ${r.stderr || r.stdout}`);
  }

  const settingsFile = join(ctxHome, "claude-no-hooks.settings.json");
  writeFileSync(settingsFile, JSON.stringify({ disableAllHooks: true }));

  // A `ctx` shim forwarding to THIS tree's CLI, so the model never hits a stale
  // globally-installed ctx (schema may differ). On Windows a `ctx.cmd` covers both
  // `ctx` and `ctx.cmd` invocations via PATHEXT; on POSIX an executable `ctx`.
  const shimDir = mkdtempSync(join(tmpdir(), "ctxpull-bin-"));
  if (IS_WIN) {
    writeFileSync(join(shimDir, "ctx.cmd"), `@echo off\r\nbun "${CTX_ENTRY}" %*\r\n`);
  } else {
    const shim = join(shimDir, "ctx");
    writeFileSync(shim, `#!/bin/sh\nexec bun "${CTX_ENTRY}" "$@"\n`, { mode: 0o755 });
  }

  return {
    ctxHome,
    repo,
    settingsFile,
    shimDir,
    cleanup: () => {
      rmSync(ctxHome, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
      rmSync(shimDir, { recursive: true, force: true });
    },
  };
}

interface EnvelopeLite {
  rules: string[];
  renderedChars: number;
  approxTokens: number;
}

/** Retrieve via the universal `ctx agent context` contract (same engine as `ctx get`). */
export function retrieve(sb: Sandbox, task: string): EnvelopeLite {
  const payload = JSON.stringify({ task, cwd: sb.repo });
  const r = runCtx(["agent", "context", "--stdin"], sb.ctxHome, sb.repo, payload);
  if (r.code !== 0) throw new Error(`ctx agent context exited ${r.code}: ${r.stderr || r.stdout}`);
  const env = JSON.parse(r.stdout) as {
    context: { authoritativePreferences: Array<{ rule: string }> };
    meta: { diagnostics: { renderedChars: number; approxTokens: number } };
  };
  return {
    rules: env.context.authoritativePreferences.map((p) => p.rule.toLowerCase()),
    renderedChars: env.meta.diagnostics.renderedChars,
    approxTokens: env.meta.diagnostics.approxTokens,
  };
}

/** True when a returned rule contains any expected substring. */
function hitsExpected(rules: string[], expect?: string[]): boolean {
  if (!expect || expect.length === 0) return rules.length > 0;
  return rules.some((r) => expect.some((e) => r.includes(e.toLowerCase())));
}

/**
 * Deterministic pass (spec §12): no model. For each scenario, retrieve and record
 * whether ctx returned the expected preference (relevant) or wrongly returned
 * anything (irrelevant), plus the response size.
 */
export function deterministicPass(sb: Sandbox, scenarios: Scenario[] = ALL_SCENARIOS): DeterministicResult[] {
  return scenarios.map((s) => {
    const env = retrieve(sb, s.probe);
    const retrievedExpected = s.relevant
      ? hitsExpected(env.rules, s.expectRuleIncludes)
      : env.rules.length > 0; // for irrelevant, "retrievedExpected" = wrongly surfaced something
    return {
      scenarioId: s.id,
      relevant: s.relevant,
      retrievedExpected,
      returnedRuleCount: env.rules.length,
      renderedChars: env.renderedChars,
      approxTokens: env.approxTokens,
    };
  });
}

// ---------------------------------------------------------------------------
// Real-model pilot (gated; spec §13–§15, §27)
// ---------------------------------------------------------------------------

/** The read-only pull invocation the standing instruction names, per platform. */
export function pullAction(): string {
  return IS_WIN
    ? 'run `ctx.cmd get --cwd "$PWD" --task "<concise task>"`'
    : 'run `ctx get --cwd "$PWD" --task "<concise task>"`';
}

/** Compose the single headless prompt: the standing instruction under test + probe. */
export function composePilotPrompt(probe: string): string {
  const instruction = renderPullGuidance({ action: pullAction(), heading: "## Developer context policy" });
  return `${instruction}\n\n---\n\n${probe}`;
}

/** Detect an autonomous ctx retrieval call in an observed shell command / tool name. */
export function isCtxGetCommand(cmd: string): boolean {
  const c = cmd.toLowerCase();
  return /\bctx(\.cmd)?\s+get\b/.test(c) || /\bctx(\.cmd)?\s+agent\s+context\b/.test(c) || c.includes("get_context");
}

/** Extract the `--task` argument from an observed `ctx get` command, if present. */
export function extractTaskArg(cmd: string): string | null {
  const m = cmd.match(/--task\s+("([^"]*)"|'([^']*)'|(\S+))/);
  if (!m) return null;
  return (m[2] ?? m[3] ?? m[4] ?? "").trim() || null;
}

interface ParsedStream {
  commands: string[];
  finalText: string;
  costUsd: number | null;
}

/** Parse Claude Code stream-json into observed shell commands + final text + cost. */
export function parseStream(stdout: string): ParsedStream {
  const commands: string[] = [];
  let finalText = "";
  let costUsd: number | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    const content = evt?.message?.content ?? evt?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_use") {
          const input = block.input ?? {};
          if (typeof input.command === "string") commands.push(input.command);
          // An MCP get_context call shows up as a tool_use with that name.
          if (String(block.name ?? "").toLowerCase().includes("get_context")) commands.push("get_context");
        } else if (block?.type === "text" && typeof block.text === "string") {
          finalText = block.text;
        }
      }
    }
    if (evt?.type === "result") {
      if (typeof evt.result === "string") finalText = evt.result;
      if (typeof evt.total_cost_usd === "number") costUsd = evt.total_cost_usd;
    }
  }
  return { commands, finalText, costUsd };
}

export interface PilotOptions {
  model: string;
  transcriptDir: string;
  /** Scenarios to run, already sliced to the planned budget by the CLI. */
  scenarios: Scenario[];
}

function transcriptPathFor(dir: string, scenarioId: string, prompt: string): string {
  const h = createHash("sha1").update(prompt).digest("hex").slice(0, 8);
  return join(dir, `${scenarioId}-${h}.jsonl`);
}

/** Run one scenario through Claude headless and observe whether it pulled ctx. */
function runOnePilot(sb: Sandbox, s: Scenario, opts: PilotOptions): Promise<PilotTrial> {
  const prompt = composePilotPrompt(s.probe);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    opts.model,
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    // Disable the host push hook so this measures the PULL decision alone. Merges with
    // user settings, so auth is untouched (see Sandbox.settingsFile).
    "--settings",
    sb.settingsFile,
  ];
  const start = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn("claude", args, {
        cwd: sb.repo,
        env: {
          ...process.env,
          CTX_HOME: sb.ctxHome,
          // Shim dir first so the model's `ctx`/`ctx.cmd` runs THIS tree's CLI.
          PATH: `${sb.shimDir}${IS_WIN ? ";" : ":"}${process.env.PATH ?? ""}`,
        },
        shell: IS_WIN,
      });
    } catch {
      return resolve(baseTrial(s, { infraError: true }));
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(baseTrial(s, { infraError: true }));
    });
    child.on("close", () => {
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      const transcriptPath = transcriptPathFor(opts.transcriptDir, s.id, prompt);
      try {
        mkdirSync(opts.transcriptDir, { recursive: true });
        writeFileSync(transcriptPath, stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : ""));
        writeFileSync(join(opts.transcriptDir, `${s.id}.prompt.txt`), prompt);
      } catch {
        /* best effort */
      }
      if (stdout.trim().length === 0) {
        return resolve(baseTrial(s, { infraError: true, transcriptPath, latencyMs }));
      }
      const { commands, finalText, costUsd } = parseStream(stdout);
      const ctxCmds = commands.filter(isCtxGetCommand);
      const calledCtx = ctxCmds.length > 0;
      const ctxQuery = ctxCmds.map(extractTaskArg).find(Boolean) ?? null;

      let retrievalReturnedExpected: boolean | null = null;
      let adheredAfterPull: boolean | null = null;
      if (s.relevant && calledCtx) {
        // Replay the model's own query (fallback to the probe) through ctx to see if
        // the engine returned the expected preference for what the model actually asked.
        const replay = retrieve(sb, ctxQuery ?? s.probe);
        retrievalReturnedExpected = hitsExpected(replay.rules, s.expectRuleIncludes);
        if (retrievalReturnedExpected) {
          const hay = (finalText + "\n" + commands.join("\n")).toLowerCase();
          adheredAfterPull = (s.expectRuleIncludes ?? []).some((e) => hay.includes(e.toLowerCase()));
        }
      }

      resolve({
        scenarioId: s.id,
        relevant: s.relevant,
        calledCtx,
        ctxQuery,
        retrievalReturnedExpected,
        contextAlreadyPushed: false, // pull pilot never pushes — see score.ts §19 note
        adheredAfterPull,
        infraError: false,
        transcriptPath,
        latencyMs,
        costUsd,
      });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function baseTrial(s: Scenario, over: Partial<PilotTrial>): PilotTrial {
  return {
    scenarioId: s.id,
    relevant: s.relevant,
    calledCtx: false,
    ctxQuery: null,
    retrievalReturnedExpected: null,
    contextAlreadyPushed: false,
    adheredAfterPull: null,
    infraError: false,
    ...over,
  };
}

/** Run the pilot sequentially (one claude process at a time) and return all trials. */
export async function runPilot(sb: Sandbox, opts: PilotOptions): Promise<PilotTrial[]> {
  const trials: PilotTrial[] = [];
  for (const s of opts.scenarios) {
    trials.push(await runOnePilot(sb, s, opts));
  }
  return trials;
}

/** `claude --version`, or null if unavailable. */
export function claudeVersion(): string | null {
  try {
    const r = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 15_000, shell: IS_WIN });
    return (r.status ?? 1) === 0 ? ((r.stdout ?? "") + (r.stderr ?? "")).trim() : null;
  } catch {
    return null;
  }
}
