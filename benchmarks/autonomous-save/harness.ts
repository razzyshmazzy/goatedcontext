/**
 * Autonomous-save benchmark harness.
 *
 * Black-box over the shipped ctx CLI (this working tree). The pilot spawns Claude Code
 * headless in a fresh isolated sandbox per trial (its own CTX_HOME + git repo), with the
 * host push hook disabled and a PATH `ctx` shim routing to this tree, then reads the
 * ACTUAL ctx state after the turn (spec §27) — we score the store, never the prose.
 * Imports only the shared save-policy asset (the exact standing instruction under test).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { renderSaveGuidance } from "../../src/core/assets/save-policy.ts";
import { claudePermissionRules } from "../../src/core/agents/permissions.ts";
import type { Scenario, Seed } from "./scenarios.ts";
import type { CtxState, PrefRow } from "./score.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
const CTX_ENTRY = join(REPO_ROOT, "src", "index.ts");
const IS_WIN = process.platform === "win32";

export interface Sandbox {
  ctxHome: string;
  repo: string;
  shimDir: string;
  settingsFile: string;
  /** File holding the save policy, passed as --append-system-prompt-file so the policy
   *  is SYSTEM context (like CLAUDE.md) and the user message is the actual turn — the
   *  faithful emulation that avoids a bare preference line being read as non-actionable. */
  policyFile: string;
  cleanup: () => void;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

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

/**
 * Settings for the sandbox's Claude `--settings`. In `realistic` mode we install the
 * SAME narrow agent permission rules `ctx install claude` writes — so the agent surface
 * (`ctx agent remember` …) is auto-approved while the BARE human commands are NOT (and
 * are denied in headless). That is the production boundary the pilot must test, not
 * bypassPermissions (which silently lets bare writes through). Plus a minimal read
 * allow-list so the model isn't derailed by incidental denials.
 */
function sandboxSettings(realistic: boolean): Record<string, unknown> {
  if (!realistic) return { disableAllHooks: true };
  const rules = claudePermissionRules(process.platform);
  const reads = ["ls", "cat", "pwd", "git status", "git log", "dir", "Get-ChildItem", "Get-Content"];
  const readRules = reads.map((r) => `Bash(${r}:*)`);
  return { disableAllHooks: true, permissions: { allow: [...rules.allow, ...readRules], deny: rules.deny } };
}

/** Fresh isolated sandbox; optionally pre-seed one preference (correction/temporary). */
export function setupSandbox(seed?: Seed, realistic = false): Sandbox {
  const ctxHome = mkdtempSync(join(tmpdir(), "ctxsave-home-"));
  const repo = mkdtempSync(join(tmpdir(), "ctxsave-repo-"));
  const git = (a: string[]) => spawnSync("git", a, { cwd: repo, stdio: "ignore" });
  git(["init", "-q"]);
  git(["remote", "add", "origin", "https://github.com/acme/save-bench.git"]);
  runCtx(["init"], ctxHome, repo);

  if (seed) {
    // Seed a plain PREFERENCE only. We deliberately do NOT attach a decision-signal:
    // a seeded signal would pollute the post-trial signal state and be misattributed to
    // the model. The preference's domain is inferred from the rule, which is all the
    // exclusive-domain correction logic needs.
    const args = ["agent", "remember", seed.rule, "--origin", "user", "--scope", seed.scope, "--agent-id", "ctxsave-seed"];
    if (seed.applicability === "always") args.push("--always");
    const r = runCtx(args, ctxHome, repo);
    if (r.code !== 0) throw new Error(`seed failed: ${r.stderr || r.stdout}`);
  }

  const settingsFile = join(ctxHome, "claude-no-hooks.settings.json");
  writeFileSync(settingsFile, JSON.stringify(sandboxSettings(realistic)));
  const shimDir = mkdtempSync(join(tmpdir(), "ctxsave-bin-"));
  if (IS_WIN) writeFileSync(join(shimDir, "ctx.cmd"), `@echo off\r\nbun "${CTX_ENTRY}" %*\r\n`);
  else writeFileSync(join(shimDir, "ctx"), `#!/bin/sh\nexec bun "${CTX_ENTRY}" "$@"\n`, { mode: 0o755 });

  const policyFile = join(ctxHome, "save-policy.systemprompt.txt");
  writeFileSync(policyFile, savePolicySystemPrompt());

  return {
    ctxHome,
    repo,
    shimDir,
    settingsFile,
    policyFile,
    cleanup: () => {
      for (const d of [ctxHome, repo, shimDir]) rmSync(d, { recursive: true, force: true });
    },
  };
}

/** The save policy as SYSTEM-prompt text (emulates the standing CLAUDE.md block). */
export function savePolicySystemPrompt(): string {
  return renderSaveGuidance({ command: saveAction(), skillName: "context-learn", heading: "## Memory save policy" });
}

/** Read the ACTUAL ctx state from the sandbox (spec §27). */
export function inspectState(sb: Sandbox): CtxState {
  const prefsRaw = runCtx(["prefs", "--json"], sb.ctxHome, sb.repo);
  const allRaw = runCtx(["prefs", "--json", "--include-proposed"], sb.ctxHome, sb.repo);
  const sigRaw = runCtx(["signals", "--json"], sb.ctxHome, sb.repo);
  const prefs = safeParse<PrefRow[]>(prefsRaw.stdout, []);
  const all = safeParse<PrefRow[]>(allRaw.stdout, []);
  const sigs = safeParse<Array<{ domain: string; choices: Array<{ choice: string }> }>>(sigRaw.stdout, []);
  const inEffect = new Set(prefs.map((p) => p.rule + "|" + p.scope));
  return {
    prefs,
    proposals: all.filter((p) => p.status !== "approved" && p.status !== "locked" && !inEffect.has(p.rule + "|" + p.scope)),
    signalDomains: sigs.map((s) => ({ domain: s.domain, choices: s.choices.map((c) => c.choice) })),
  };
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** The retrieval view (to confirm a correction superseded the old choice). */
export function retrievedRules(sb: Sandbox, task: string): string[] {
  const r = runCtx(["get", "--cwd", sb.repo, "--task", task], sb.ctxHome, sb.repo);
  const j = safeParse<{ preferences?: Array<{ rule: string }> }>(r.stdout, {});
  return (j.preferences ?? []).map((p) => p.rule.toLowerCase());
}

// ---------------------------------------------------------------------------
// Pilot (gated; spec §26–§30)
// ---------------------------------------------------------------------------

export function saveAction(): string {
  return IS_WIN ? "ctx.cmd" : "ctx";
}

/**
 * The USER turn sent as the prompt. The save policy is NOT concatenated here — it is
 * supplied as a system prompt (--append-system-prompt-file), mirroring how CLAUDE.md is
 * system context and the user message is the actual turn. This keeps a terse standalone
 * preference from being read as inert policy text.
 */
export function composePrompt(scenario: Scenario): string {
  return scenario.userMessage;
}

interface ParsedStream {
  commands: string[];
  finalText: string;
  costUsd: number | null;
  permissionDenials: number;
}

export function parseStream(stdout: string): ParsedStream {
  const commands: string[] = [];
  let finalText = "";
  let costUsd: number | null = null;
  let permissionDenials = 0;
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
      for (const b of content) {
        if (b?.type === "tool_use") {
          const inp = b.input ?? {};
          if (typeof inp.command === "string") commands.push(inp.command);
          const name = String(b.name ?? "").toLowerCase();
          if (name.includes("remember") || name.includes("record_decision") || name.includes("propose")) {
            commands.push(`mcp:${name} ${JSON.stringify(inp)}`);
          }
        } else if (b?.type === "text" && typeof b.text === "string") finalText = b.text;
      }
    }
    if (evt?.type === "result") {
      if (typeof evt.result === "string") finalText = evt.result;
      if (typeof evt.total_cost_usd === "number") costUsd = evt.total_cost_usd;
      if (Array.isArray(evt.permission_denials)) permissionDenials = evt.permission_denials.length;
    }
  }
  return { commands, finalText, costUsd, permissionDenials };
}

export type WriteSurface = "agent" | "human" | "mcp" | "mixed" | "none";

/** Classify which WRITE surface the model used, from observed shell/MCP invocations. */
export function classifyWriteSurface(commands: string[]): WriteSurface {
  const isAgentCli = (c: string) => /\bctx(\.cmd)?\s+agent\s+(remember|propose|signal\s+add)\b/.test(c);
  const isMcp = (c: string) => /^mcp:(remember|propose|record_decision)\b/.test(c);
  const isBareHuman = (c: string) =>
    /\bctx(\.cmd)?\s+(remember|propose|signal\s+add)\b/.test(c) && !/\bctx(\.cmd)?\s+agent\b/.test(c);
  const hasAgent = commands.some((c) => isAgentCli(c) || isMcp(c));
  const hasHuman = commands.some(isBareHuman);
  if (hasAgent && hasHuman) return "mixed";
  if (hasAgent) return "agent";
  if (hasHuman) return "human";
  return "none";
}

/** Every write command observed (agent CLI, bare human CLI, or MCP) — for surface audit. */
function writeCommands(commands: string[]): string[] {
  return commands.filter(
    (c) => /\bctx(\.cmd)?\s+(agent\s+)?(remember|propose|signal\s+add)\b/.test(c) || /^mcp:(remember|propose|record_decision)\b/.test(c),
  );
}

export function claudeVersion(): string | null {
  try {
    const r = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 15_000, shell: IS_WIN });
    return (r.status ?? 1) === 0 ? ((r.stdout ?? "") + (r.stderr ?? "")).trim() : null;
  } catch {
    return null;
  }
}

export interface Trial {
  id: string;
  group: Scenario["group"];
  expectedAction: string;
  observedCommands: string[];
  state: CtxState;
  /** Did any ctx write command run at all? */
  wroteAnything: boolean;
  costUsd: number | null;
  latencyMs: number;
  transcriptPath?: string;
  infraError: boolean;
  /** For correction scenarios: the precedence-applied retrieval view (lowercased). */
  retrieved: string[];
  /** Which write surface the model actually used (the §12 command-path signal). */
  writeSurface: WriteSurface;
  /** Count of tools the host denied (realistic mode: a denied bare write shows here). */
  permissionDenials: number;
}

function runOne(scenario: Scenario, model: string, transcriptDir: string, realistic = false): Promise<Trial> {
  const sb = setupSandbox(scenario.seed, realistic);
  const prompt = composePrompt(scenario);
  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--model", model,
    // realistic: enforce the installed agent permission boundary (bare writes are denied,
    // not silently allowed). Otherwise bypass so nothing blocks the write.
    "--permission-mode", realistic ? "default" : "bypassPermissions",
    "--no-session-persistence",
    "--settings", sb.settingsFile,
    // Save policy as SYSTEM context (like CLAUDE.md); the user turn is the prompt.
    "--append-system-prompt-file", sb.policyFile,
  ];
  const start = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn("claude", args, {
        cwd: sb.repo,
        env: { ...process.env, CTX_HOME: sb.ctxHome, PATH: `${sb.shimDir}${IS_WIN ? ";" : ":"}${process.env.PATH ?? ""}` },
        shell: IS_WIN,
      });
    } catch {
      const t = finalize(scenario, sb, "", 0, true, undefined);
      sb.cleanup();
      return resolve(t);
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      const t = finalize(scenario, sb, "", Date.now() - start, true, undefined);
      sb.cleanup();
      resolve(t);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const latency = Date.now() - start;
      const id = `${scenario.id}-${createHash("sha1").update(prompt).digest("hex").slice(0, 6)}`;
      const transcriptPath = join(transcriptDir, `${id}.jsonl`);
      try {
        writeFileSync(transcriptPath, stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : ""));
        // Record BOTH the system policy and the user turn, so what was sent is provable.
        writeFileSync(join(transcriptDir, `${scenario.id}.prompt.txt`), `[SYSTEM]\n${savePolicySystemPrompt()}\n\n[USER]\n${prompt}`);
      } catch {
        /* best effort */
      }
      const infra = stdout.trim().length === 0;
      const t = finalize(scenario, sb, stdout, latency, infra, transcriptPath);
      sb.cleanup();
      resolve(t);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Read final ctx state + parse the transcript into a Trial, then the caller cleans up. */
function finalize(scenario: Scenario, sb: Sandbox, stdout: string, latencyMs: number, infraError: boolean, transcriptPath?: string): Trial {
  const parsed = parseStream(stdout);
  const state = inspectState(sb);
  const seededRule = scenario.seed?.rule;
  const newPrefs = state.prefs.filter((p) => p.rule !== seededRule);
  const wroteAnything = newPrefs.length > 0 || state.proposals.length > 0 || state.signalDomains.length > 0;
  // For a correction, capture the precedence-applied retrieval view BEFORE cleanup, so
  // scoring can tell whether the old choice was truly superseded (not just still a row).
  const retrieved = scenario.expected.supersedes != null ? retrievedRules(sb, scenario.userMessage + " " + (scenario.seed?.domain ?? "")) : [];
  const writes = writeCommands(parsed.commands);
  return {
    id: scenario.id,
    group: scenario.group,
    expectedAction: scenario.expected.action,
    // Capture EVERY write command (agent AND bare human AND MCP) so the human-surface
    // use that §12 must detect is never filtered away.
    observedCommands: writes,
    writeSurface: classifyWriteSurface(parsed.commands),
    state,
    wroteAnything,
    costUsd: parsed.costUsd,
    latencyMs,
    transcriptPath,
    infraError,
    retrieved,
    permissionDenials: parsed.permissionDenials,
  };
}

export async function runPilot(scenarios: Scenario[], model: string, transcriptDir: string, realistic = false): Promise<Trial[]> {
  const trials: Trial[] = [];
  for (const s of scenarios) trials.push(await runOne(s, model, transcriptDir, realistic));
  return trials;
}
