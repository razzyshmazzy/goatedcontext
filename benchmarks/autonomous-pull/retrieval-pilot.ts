/**
 * Retrieval real-model confirmation pilot (retrieval pass, spec §17).
 *
 * A HARD-CAPPED (≤8, default 6) real-Claude confirmation of the retrieval improvements.
 * Drives the SHIPPED ctx CLI as a black box behind a real `claude -p` headless run, with
 * the host push hook DISABLED so we observe the PULL decision in isolation (same method
 * as the v1.1 pull pilot). It measures, per case: did the model call ctx, what query did
 * it form, did that query retrieve the expected memory (engine replay), and did the model
 * adhere. Covers the spec's six cases including naming and the two-turn "ctx it".
 *
 * Gated: requires CTXBENCH_ENABLE_CLAUDE=1 and CTXBENCH_MODEL=<model> (default label
 * reported from `claude --version`). Nothing runs otherwise.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPullGuidance } from "../../src/core/assets/retrieval-policy.ts";
import {
  runCtx,
  retrieve as retrieveEnvelope,
  pullAction,
  parseStream,
  isCtxGetCommand,
  extractTaskArg,
  claudeVersion,
  type Sandbox,
  REPO_ROOT,
} from "./harness.ts";

const IS_WIN = process.platform === "win32";
const CTX_ENTRY = join(REPO_ROOT, "src", "index.ts");
const HARD_CAP = 8;

interface PilotCase {
  id: string;
  relevant: boolean;
  /** The single headless prompt (policy + probe, or a crafted two-turn transcript). */
  prompt: string;
  /** Replay query fallback + expectation matcher. */
  probeForReplay: string;
  expect: string[];
  note: string;
}

const POLICY = renderPullGuidance({ action: pullAction(), heading: "## Developer context policy" });

/** Seed set shared by all cases (seeded once into the isolated store). */
const SEEDS: string[] = [
  "Use pnpm as the package manager; never npm or yarn.",
  "Use Vitest for unit tests.",
  "Call me Greg.",
  "Use Redis for caching.",
];

const CASES: PilotCase[] = [
  {
    id: "1-dependency-hidden-pm",
    relevant: true,
    prompt: `${POLICY}\n\n---\n\nAdd the uuid package to this project.`,
    probeForReplay: "package manager to add the uuid dependency in this repo",
    expect: ["pnpm"],
    note: "hidden package-manager preference",
  },
  {
    id: "2-oblique-testing",
    relevant: true,
    prompt: `${POLICY}\n\n---\n\nThis parser has no safety net yet — give it one.`,
    probeForReplay: "testing framework and conventions for this repository",
    expect: ["vitest"],
    note: "oblique test request, hidden testing preference",
  },
  {
    id: "3-naming",
    relevant: true,
    prompt: `${POLICY}\n\n---\n\nWhat do you call me?`,
    probeForReplay: "the user's preferred name / how they want to be addressed",
    expect: ["greg"],
    note: "stored naming preference",
  },
  {
    id: "4-ctx-it-two-turn",
    relevant: true,
    prompt:
      `${POLICY}\n\n---\n\n` +
      `This is a continuing conversation.\n` +
      `Earlier the user asked: "What do you call me?" — you did not have the answer and did not reply.\n` +
      `The user now says: "ctx it"`,
    probeForReplay: "the user's preferred name / how they want to be addressed",
    expect: ["greg"],
    note: "previous-turn inheritance via explicit command",
  },
  {
    id: "5-prior-architecture-decision",
    relevant: true,
    prompt: `${POLICY}\n\n---\n\nWhat did we decide to use for caching?`,
    probeForReplay: "caching layer / architecture decision for this project",
    expect: ["redis"],
    note: "prior architecture decision",
  },
  {
    id: "6-unrelated-factual",
    relevant: false,
    prompt: `${POLICY}\n\n---\n\nExplain TCP slow start.`,
    probeForReplay: "Explain TCP slow start.",
    expect: [],
    note: "unrelated factual question (must NOT retrieve)",
  },
];

function buildSandbox(): Sandbox {
  const ctxHome = mkdtempSync(join(tmpdir(), "ctxrpilot-home-"));
  const repo = mkdtempSync(join(tmpdir(), "ctxrpilot-repo-"));
  const git = (a: string[]) => spawnSync("git", a, { cwd: repo, stdio: "ignore" });
  git(["init", "-q"]);
  git(["remote", "add", "origin", "https://github.com/acme/retrieval-pilot.git"]);
  runCtx(["init"], ctxHome, repo);
  for (const rule of SEEDS) {
    const r = runCtx(["agent", "remember", rule, "--origin", "user", "--scope", "global", "--agent-id", "rpilot"], ctxHome, repo);
    if (r.code !== 0) throw new Error(`seed failed (${rule}): ${r.stderr || r.stdout}`);
  }
  const settingsFile = join(ctxHome, "claude-no-hooks.settings.json");
  writeFileSync(settingsFile, JSON.stringify({ disableAllHooks: true }));
  const shimDir = mkdtempSync(join(tmpdir(), "ctxrpilot-bin-"));
  if (IS_WIN) writeFileSync(join(shimDir, "ctx.cmd"), `@echo off\r\nbun "${CTX_ENTRY}" %*\r\n`);
  else {
    const shim = join(shimDir, "ctx");
    writeFileSync(shim, `#!/bin/sh\nexec bun "${CTX_ENTRY}" "$@"\n`, { mode: 0o755 });
  }
  return {
    ctxHome, repo, settingsFile, shimDir,
    cleanup: () => {
      rmSync(ctxHome, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
      rmSync(shimDir, { recursive: true, force: true });
    },
  };
}

interface Trial {
  id: string;
  relevant: boolean;
  calledCtx: boolean;
  query: string | null;
  retrievalReturnedExpected: boolean | null;
  adhered: boolean | null;
  infraError: boolean;
}

function runOne(sb: Sandbox, c: PilotCase, model: string, transcriptDir: string): Promise<Trial> {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--model", model, "--permission-mode", "bypassPermissions",
    "--no-session-persistence", "--settings", sb.settingsFile,
  ];
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
      return resolve({ id: c.id, relevant: c.relevant, calledCtx: false, query: null, retrievalReturnedExpected: null, adhered: null, infraError: true });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => { clearTimeout(timer); resolve({ id: c.id, relevant: c.relevant, calledCtx: false, query: null, retrievalReturnedExpected: null, adhered: null, infraError: true }); });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        mkdirSync(transcriptDir, { recursive: true });
        writeFileSync(join(transcriptDir, `${c.id}.jsonl`), stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : ""));
        writeFileSync(join(transcriptDir, `${c.id}.prompt.txt`), c.prompt);
      } catch { /* best effort */ }
      if (stdout.trim().length === 0) {
        return resolve({ id: c.id, relevant: c.relevant, calledCtx: false, query: null, retrievalReturnedExpected: null, adhered: null, infraError: true });
      }
      const { commands, finalText } = parseStream(stdout);
      const ctxCmds = commands.filter(isCtxGetCommand);
      const calledCtx = ctxCmds.length > 0;
      const query = ctxCmds.map(extractTaskArg).find(Boolean) ?? null;
      let retrievalReturnedExpected: boolean | null = null;
      let adhered: boolean | null = null;
      if (c.relevant && calledCtx) {
        const replay = retrieveEnvelope(sb, query ?? c.probeForReplay).rules;
        retrievalReturnedExpected = c.expect.some((e) => replay.some((r) => r.includes(e.toLowerCase())));
      }
      if (c.relevant) {
        const hay = (finalText + "\n" + commands.join("\n")).toLowerCase();
        adhered = c.expect.some((e) => hay.includes(e.toLowerCase()));
      }
      resolve({ id: c.id, relevant: c.relevant, calledCtx, query, retrievalReturnedExpected, adhered, infraError: false });
    });
    child.stdin.write(c.prompt);
    child.stdin.end();
  });
}

const enabled = process.env.CTXBENCH_ENABLE_CLAUDE === "1";
const model = process.env.CTXBENCH_MODEL ?? "sonnet";
const version = claudeVersion();

function log(s = "") { process.stdout.write(s + "\n"); }

log("== Retrieval real-model pilot — cost guard ==");
log(`  cases        : ${CASES.length} (${CASES.filter((c) => c.relevant).length} relevant, ${CASES.filter((c) => !c.relevant).length} negative)`);
log(`  model        : ${model}`);
log(`  claude binary: ${version ?? "(unavailable)"}`);
log(`  hard cap     : ${HARD_CAP}`);
if (CASES.length > HARD_CAP) { log(`STOP: ${CASES.length} > cap ${HARD_CAP}`); process.exit(1); }
if (!enabled) { log("\nGATED: set CTXBENCH_ENABLE_CLAUDE=1 (and CTXBENCH_MODEL) to run live. No calls made."); process.exit(0); }
if (!version) { log("\nABORT: `claude` not found."); process.exit(1); }

const transcriptDir = join(REPO_ROOT, "benchmarks", "results", "retrieval-pilot-transcripts");
const sb = buildSandbox();
const trials: Trial[] = [];
try {
  log(`\nRunning ${CASES.length} live trials sequentially…`);
  for (const c of CASES) {
    const t = await runOne(sb, c, model, transcriptDir);
    trials.push(t);
    log(`  ${t.id.padEnd(30)} called=${t.calledCtx} retr=${t.retrievalReturnedExpected} adhered=${t.adhered}${t.infraError ? " INFRA-ERR" : ""}`);
    if (t.query) log(`      query: ${JSON.stringify(t.query)}`);
  }
} finally {
  sb.cleanup();
}

const rel = trials.filter((t) => t.relevant && !t.infraError);
const neg = trials.filter((t) => !t.relevant && !t.infraError);
const relCalled = rel.filter((t) => t.calledCtx);
const frac = (n: number, d: number) => `${n}/${d}${d ? ` (${Math.round((n / d) * 100)}%)` : ""}`;
log("\n== Metrics (exact numerator/denominator) ==");
log(`  Tool Recall (relevant called)      : ${frac(relCalled.length, rel.length)}`);
log(`  Tool Precision (relevant / called) : ${frac(relCalled.length, trials.filter((t) => t.calledCtx && !t.infraError).length)}`);
log(`  Unnecessary calls (negatives)      : ${frac(neg.filter((t) => t.calledCtx).length, neg.length)}`);
log(`  Query Success (retr after call)    : ${frac(relCalled.filter((t) => t.retrievalReturnedExpected).length, relCalled.length)}`);
log(`  Adherence (relevant answered right): ${frac(rel.filter((t) => t.adhered).length, rel.length)}`);
log(`  Infra errors                       : ${trials.filter((t) => t.infraError).length}`);
try {
  const out = join(transcriptDir, "retrieval-pilot-result.json");
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(out, JSON.stringify({ trials }, null, 2));
  log(`  result artifact: ${out}`);
} catch { /* best effort */ }
