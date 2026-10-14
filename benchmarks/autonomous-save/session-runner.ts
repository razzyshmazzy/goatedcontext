/**
 * Multi-turn session runner for the autonomous-memory accumulation eval.
 *
 * Runs ONE real continuing Claude session per script (stream-json input), so ~12 user
 * turns share one process, one repo, one CTX_HOME — memory accumulates over time. Between
 * turns we snapshot the ACTUAL ctx store (never prose). The production permission boundary
 * is enforced (agent writes allowed; bare human writes denied). Host hooks are disabled and
 * the standing save+pull policy is supplied as a system prompt (the pull path is exercised;
 * the push hook is intentionally not, to keep the long session reliable and uncontaminated
 * by the stale global hook — noted as a blind spot).
 *
 * Eval tooling only — imports no production code except the policy assets + the shared
 * black-box ctx bridge. Changes NO product behavior.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderSaveGuidance } from "../../src/core/assets/save-policy.ts";
import { renderPullGuidance } from "../../src/core/assets/retrieval-policy.ts";
import { claudePermissionRules } from "../../src/core/agents/permissions.ts";
import { inspectState, runCtx, classifyWriteSurface, type WriteSurface } from "./harness.ts";
import type { CtxState } from "./score.ts";
import type { Session, Turn } from "./sessions.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
const CTX_ENTRY = join(REPO_ROOT, "src", "index.ts");
const IS_WIN = process.platform === "win32";
const ctxCmd = IS_WIN ? "ctx.cmd" : "ctx";

interface SessionSandbox {
  ctxHome: string;
  repo: string;
  shimDir: string;
  settingsFile: string;
  policyFile: string;
  cleanup: () => void;
}

/** The standing policy the model carries (save + pull), mirroring the CLAUDE.md block. */
export function sessionSystemPrompt(): string {
  const save = renderSaveGuidance({ command: ctxCmd, skillName: "context-learn", heading: "## Memory save policy" });
  const pull = renderPullGuidance({
    action: `run \`${ctxCmd} get --cwd "$PWD" --task "<concise task>"\``,
    heading: "## Memory retrieval policy",
  });
  return `${pull}\n\n${save}`;
}

function minimalRepoFiles(repo: string, kind: Session["repoKind"]): void {
  const pkg =
    kind === "ts"
      ? { name: "ts-app", version: "0.0.0", private: true, devDependencies: { typescript: "^5.5.0" } }
      : { name: "backend-svc", version: "0.0.0", private: true, dependencies: {} };
  writeFileSync(join(repo, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "index.ts"), "export {};\n");
}

export function setupSessionSandbox(kind: Session["repoKind"]): SessionSandbox {
  const ctxHome = mkdtempSync(join(tmpdir(), "ctxsess-home-"));
  const repo = mkdtempSync(join(tmpdir(), "ctxsess-repo-"));
  const git = (a: string[]) => spawnSync("git", a, { cwd: repo, stdio: "ignore" });
  git(["init", "-q"]);
  git(["remote", "add", "origin", `https://github.com/acme/${kind}-sess.git`]);
  minimalRepoFiles(repo, kind);
  git(["add", "-A"]);
  git(["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  runCtx(["init"], ctxHome, repo);

  const shimDir = mkdtempSync(join(tmpdir(), "ctxsess-bin-"));
  // Shadow BOTH spellings so the model reaches THIS tree regardless of shell/launcher:
  //   - `ctx.cmd` for cmd/PowerShell (and bare `ctx` via PATHEXT there);
  //   - a shebang `ctx` script for Git Bash, which does NOT honor PATHEXT and would
  //     otherwise fall through PATH to the stale globally-installed ctx (0.3.4, no
  //     `agent` subcommand). Both must exist or a dropped `.cmd` silently hits the wrong
  //     binary (the harness bug this fixes).
  writeFileSync(join(shimDir, "ctx"), `#!/bin/sh\nexec bun "${CTX_ENTRY}" "$@"\n`, { mode: 0o755 });
  if (IS_WIN) writeFileSync(join(shimDir, "ctx.cmd"), `@echo off\r\nbun "${CTX_ENTRY}" %*\r\n`);

  // Production boundary: agent writes auto-approved, bare human writes NOT (denied in
  // headless default mode). Plus a read allow-list so exploration isn't derailed.
  const rules = claudePermissionRules(process.platform);
  const reads = ["ls", "cat", "pwd", "git status", "git log", "git diff", "dir", "Get-ChildItem", "Get-Content", "node", "bun", "npm", "pnpm", "npx", "mkdir", "echo", "type", "findstr", "grep", "rg"];
  const settings = {
    disableAllHooks: true,
    permissions: { allow: [...rules.allow, ...reads.map((r) => `Bash(${r}:*)`)], deny: rules.deny },
  };
  const settingsFile = join(ctxHome, "session.settings.json");
  writeFileSync(settingsFile, JSON.stringify(settings));

  const policyFile = join(ctxHome, "policy.systemprompt.txt");
  writeFileSync(policyFile, sessionSystemPrompt());

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

export interface TurnResult {
  n: number;
  user: string;
  kind: Turn["kind"];
  /** ctx write/get commands observed DURING this turn. */
  commands: string[];
  writeSurface: WriteSurface;
  pulled: boolean;
  denials: number;
  assistant: string;
  /** Full ctx snapshot taken right after this turn's result event. */
  state: CtxState;
}

export interface SessionRun {
  id: Session["id"];
  turns: TurnResult[];
  finalState: CtxState;
  totalCost: number;
  transcriptPath: string;
  error?: string;
}

const isGet = (c: string) => /\bctx(\.cmd)?\s+(get|agent\s+context)\b/.test(c) || c.includes("get_context");

/** Run one full session as a single streaming Claude process, snapshotting per turn. */
export function runSession(session: Session, model: string, transcriptDir: string): Promise<SessionRun> {
  const sb = setupSessionSandbox(session.repoKind);
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    "--permission-mode", "default",
    "--settings", sb.settingsFile,
    "--append-system-prompt-file", sb.policyFile,
  ];
  const rawLines: string[] = [];
  const turnResults: TurnResult[] = [];
  let curCommands: string[] = [];
  let curText = "";
  let totalCost = 0;
  let idx = 0;
  let buffer = "";

  return new Promise<SessionRun>((resolve) => {
    let child: ReturnType<typeof spawn>;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: string): SessionRun => {
      if (timer) clearTimeout(timer);
      const transcriptPath = join(transcriptDir, `session-${session.id}.jsonl`);
      try {
        mkdirSync(transcriptDir, { recursive: true });
        writeFileSync(transcriptPath, rawLines.join("\n"));
        writeFileSync(join(transcriptDir, `session-${session.id}.system.txt`), sessionSystemPrompt());
      } catch {
        /* best effort */
      }
      const finalState = inspectState(sb);
      const run: SessionRun = { id: session.id, turns: turnResults, finalState, totalCost, transcriptPath, error };
      sb.cleanup();
      return run;
    };

    const sendTurn = (t: Turn) => {
      const msg = { type: "user", message: { role: "user", content: t.user } };
      child.stdin!.write(JSON.stringify(msg) + "\n");
    };

    try {
      child = spawn("claude", args, {
        cwd: sb.repo,
        env: { ...process.env, CTX_HOME: sb.ctxHome, PATH: `${sb.shimDir}${IS_WIN ? ";" : ":"}${process.env.PATH ?? ""}` },
        shell: IS_WIN,
      });
    } catch (err) {
      return resolve(finish(`spawn failed: ${String(err)}`));
    }
    // Overall safety timeout for the whole session.
    timer = setTimeout(() => child.kill("SIGKILL"), 900_000);

    const onResult = (evt: any) => {
      const turn = session.turns[idx];
      if (!turn) return;
      // result.total_cost_usd is cumulative session cost → keep the latest, don't sum.
      if (typeof evt.total_cost_usd === "number") totalCost = evt.total_cost_usd;
      const denials = Array.isArray(evt.permission_denials) ? evt.permission_denials.length : 0;
      const state = inspectState(sb);
      turnResults.push({
        n: turn.n,
        user: turn.user,
        kind: turn.kind,
        commands: curCommands.slice(),
        writeSurface: classifyWriteSurface(curCommands),
        pulled: curCommands.some(isGet),
        denials,
        assistant: (typeof evt.result === "string" ? evt.result : curText).replace(/\s+/g, " ").slice(0, 300),
        state,
      });
      curCommands = [];
      curText = "";
      idx++;
      if (idx < session.turns.length) {
        sendTurn(session.turns[idx]);
      } else {
        child.stdin!.end(); // no more turns → clean session end
      }
    };

    const handleEvent = (evt: any) => {
      const content = evt?.message?.content ?? evt?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "tool_use") {
            const inp = b.input ?? {};
            if (typeof inp.command === "string") curCommands.push(inp.command);
            const name = String(b.name ?? "").toLowerCase();
            if (name.includes("get_context") || name.includes("remember") || name.includes("record_decision") || name.includes("propose")) {
              curCommands.push(`mcp:${name} ${JSON.stringify(inp)}`);
            }
          } else if (b?.type === "text" && typeof b.text === "string") {
            curText = b.text;
          }
        }
      }
      if (evt?.type === "result") onResult(evt);
    };

    child.stdout!.on("data", (d) => {
      buffer += d.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        const s = line.trim();
        if (!s) continue;
        rawLines.push(s);
        let evt: any;
        try {
          evt = JSON.parse(s);
        } catch {
          continue;
        }
        handleEvent(evt);
      }
    });
    child.stderr!.on("data", (d) => rawLines.push("[stderr] " + d.toString().trim()));
    child.on("error", (err) => resolve(finish(`child error: ${String(err)}`)));
    child.on("close", () => resolve(finish(turnResults.length < session.turns.length ? `ended early at turn ${turnResults.length}/${session.turns.length}` : undefined)));

    // Kick off the first turn.
    sendTurn(session.turns[0]);
  });
}

export function claudeVersion(): string | null {
  try {
    const r = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 15_000, shell: IS_WIN });
    return (r.status ?? 1) === 0 ? ((r.stdout ?? "") + (r.stderr ?? "")).trim() : null;
  } catch {
    return null;
  }
}
