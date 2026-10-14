/**
 * Claude Code headless adapter (spec §47). GATED: runs only when `CTXBENCH_ENABLE_CLAUDE=1`,
 * the `claude` binary is present, and an exact model is pinned via `CTXBENCH_MODEL`. It never
 * fires during the offline suite or by accident (spec §30, §53).
 *
 * One trial = one stateless `claude --print` invocation in the isolated sandbox repo. The
 * prior conversation (if any) and ctx-injected context are folded into the single prompt —
 * exactly what a UserPromptSubmit hook does — so the control/ctx contrast stays one channel.
 * Because each call is independent and started with `--no-session-persistence`, a "fresh
 * session" trial (prior turns omitted from the prompt) genuinely carries nothing across; the
 * composed prompt is stored so fresh-session purity is provable (spec §9).
 *
 * Validated against real stream-json output (see tests/claude-parser.test.ts fixture):
 * assistant `message.content[]` carries `thinking`/`text`/`tool_use`; Bash→`input.command`,
 * Write/Edit→`input.file_path`+`input.content`/`new_string`; the final `result` event carries
 * `result`, `session_id`, `total_cost_usd`, `permission_denials`, `is_error`, `num_turns`.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ObservedBehavior } from "../schema.ts";
import type { AgentAdapter, AgentRunRequest, AgentRunResult } from "./types.ts";

const IS_WIN = process.platform === "win32";

function enabled(): boolean {
  return process.env.CTXBENCH_ENABLE_CLAUDE === "1";
}
function pinnedModel(): string | null {
  const m = process.env.CTXBENCH_MODEL;
  return m && m.trim().length > 0 ? m.trim() : null;
}

/** `claude --version` → ok + text. Uses a shell on Windows (the binary is a .cmd shim). */
function claudeVersion(): { ok: boolean; out: string } {
  try {
    const r = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 15_000, shell: IS_WIN });
    return { ok: (r.status ?? 1) === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

function transcriptDir(): string {
  const dir = process.env.CTXBENCH_TRANSCRIPT_DIR || join(tmpdir(), "ctxbench-transcripts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

let trialCounter = 0;

/** Compose the single headless prompt from prior turns + injected context + probe. */
function composePrompt(req: AgentRunRequest): string {
  const parts: string[] = [];
  if (!req.freshSession && req.priorTurns.length > 0) {
    parts.push("Earlier in this session:\n" + req.priorTurns.map((t) => `- ${t}`).join("\n"));
  }
  if (req.injectedContext.trim()) parts.push(req.injectedContext.trim());
  parts.push(req.probe);
  return parts.join("\n\n");
}

interface ParsedMeta {
  sessionId: string | null;
  costUsd: number | null;
  permissionDenials: number | null;
  numTurns: number | null;
  isError: boolean | null;
}

/** Parse Claude Code `stream-json` into observed commands + file writes + run metadata. */
export function parseStream(stdout: string, repo: string): { behavior: ObservedBehavior; meta: ParsedMeta } {
  const commands: string[] = [];
  const files: Record<string, string> = {};
  let finalText = "";
  const meta: ParsedMeta = { sessionId: null, costUsd: null, permissionDenials: null, numTurns: null, isError: null };

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue; // non-JSON noise (should not happen on stdout, but never throw)
    }
    // Assistant tool_use / text blocks live under message.content[] (fallback: content[]).
    const content = evt?.message?.content ?? evt?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_use") {
          const name = String(block.name ?? "").toLowerCase();
          const input = block.input ?? {};
          // Capture shell commands from ANY shell tool, not just Bash. On Windows Claude
          // Code uses a `PowerShell` tool (also `input.command`); earlier only-Bash parsing
          // silently dropped those commands. Treat any tool_use carrying a string
          // `command` as a shell invocation (covers Bash, PowerShell, sh, pwsh, cmd, …).
          if (typeof input.command === "string") commands.push(input.command);
          if ((name === "write" || name === "edit" || name === "multiedit") && typeof input.file_path === "string") {
            const body = typeof input.content === "string" ? input.content : String(input.new_string ?? "");
            files[relativize(input.file_path, repo)] = body;
          }
        } else if (block?.type === "text" && typeof block.text === "string") {
          finalText = block.text;
        }
      }
    }
    if (evt?.type === "result") {
      if (typeof evt.result === "string") finalText = evt.result;
      meta.sessionId = evt.session_id ?? null;
      meta.costUsd = typeof evt.total_cost_usd === "number" ? evt.total_cost_usd : null;
      meta.permissionDenials = Array.isArray(evt.permission_denials) ? evt.permission_denials.length : null;
      meta.numTurns = typeof evt.num_turns === "number" ? evt.num_turns : null;
      meta.isError = typeof evt.is_error === "boolean" ? evt.is_error : null;
    }
  }
  return { behavior: { commands, files, finalText }, meta };
}

function relativize(abs: string, repo: string): string {
  const norm = abs.replace(/\\/g, "/");
  const base = repo.replace(/\\/g, "/");
  return norm.startsWith(base) ? norm.slice(base.length).replace(/^\//, "") : norm;
}

export class ClaudeHeadlessAgent implements AgentAdapter {
  readonly id = "claude";
  readonly capabilities = { freshSession: true, compaction: false };

  version(): string {
    const v = claudeVersion();
    const model = pinnedModel() ?? "UNPINNED";
    return v.ok ? `${v.out} [model=${model}]` : "unavailable";
  }

  available(): boolean {
    return enabled() && pinnedModel() != null && claudeVersion().ok;
  }

  run(req: AgentRunRequest): Promise<AgentRunResult> {
    const model = pinnedModel();
    if (!enabled() || !model) {
      return Promise.resolve({
        behavior: { commands: [], files: {}, finalText: "" },
        supported: false,
        error: "claude adapter not enabled (CTXBENCH_ENABLE_CLAUDE=1) or model not pinned (CTXBENCH_MODEL=...)",
      });
    }
    const prompt = composePrompt(req);
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      model,
      "--permission-mode",
      "bypassPermissions",
      "--no-session-persistence",
    ];

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let child;
      try {
        child = spawn("claude", args, { cwd: req.repo, env: { ...process.env }, shell: IS_WIN });
      } catch (err) {
        return resolve({ behavior: { commands: [], files: {}, finalText: "" }, supported: true, error: `spawn failed: ${String(err)}` });
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ behavior: { commands: [], files: {}, finalText: "" }, supported: true, error: `child error: ${String(err)}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        // Persist the raw transcript BEFORE parsing, so a parse bug never loses the evidence.
        const id = `${String(++trialCounter).padStart(3, "0")}-${createHash("sha1").update(prompt).digest("hex").slice(0, 8)}`;
        const transcriptPath = join(transcriptDir(), `${id}.jsonl`);
        try {
          writeFileSync(transcriptPath, stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : ""));
          writeFileSync(join(transcriptDir(), `${id}.prompt.txt`), prompt);
        } catch {
          /* best effort */
        }

        // Score ONLY what the transcript shows the agent do (tool_use commands + file
        // writes). We deliberately do NOT read package.json back off disk: a post-run disk
        // read pulls in repo METADATA (e.g. the git remote url `npm init` copies in) that
        // content-scanning scorers can false-match, and it makes live scoring diverge from
        // transcript re-scoring. Command evidence (`bun add x`, `npm install x`) is captured
        // directly and is sufficient for packageAdded; this keeps live == rescore (v1.1 fix).
        const { behavior, meta } = parseStream(stdout, req.repo);
        const noOutput = stdout.trim().length === 0;
        resolve({
          behavior,
          supported: true,
          error: noOutput ? `no stream-json output (exit ${code}): ${stderr.slice(0, 400)}` : undefined,
          transcriptPath,
          meta: { ...meta, composedPrompt: prompt },
        });
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
