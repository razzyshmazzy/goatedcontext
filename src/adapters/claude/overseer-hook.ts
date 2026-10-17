import { normalizeEvent, type AgentEvent } from "../../core/overseer/event.ts";
import type { Phase } from "../../core/overseer/vocab.ts";

/**
 * CLAUDE CODE → AgentEvent adapter (§3).
 *
 * This is the ONLY Claude-aware piece of the overseer. Its sole responsibility is to
 * translate a native Claude Code hook payload into a normalized, host-independent
 * AgentEvent. It contains NO relevance, activation, or delivery logic — all of that
 * lives in the host-independent core so Codex/Cursor adapters can map into the same
 * event type later.
 *
 * Claude hook payloads (stdin JSON) carry `session_id`, `cwd`, `hook_event_name`,
 * and for tool hooks `tool_name` + `tool_input` (and `tool_response` on PostToolUse).
 * We tolerate missing fields and never throw on shape — a malformed payload yields
 * `null`, and the caller fails open.
 */
export interface ClaudeHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

/** Tools whose native names we recognize for a recognized command segment. */
const RECOGNIZED_EXES = new Set([
  "npm", "pnpm", "yarn", "bun", "npx", "bunx", "pnpx", "pip", "pip3", "poetry",
  "cargo", "go", "vitest", "jest", "mocha", "ava", "pytest", "playwright", "cypress",
  "psql", "mysql", "sqlite3", "mongo", "mongosh", "redis-cli",
  "prisma", "drizzle-kit", "knex", "alembic", "sequelize", "rails",
  "fly", "flyctl", "vercel", "wrangler", "netlify", "kubectl", "docker",
  "eslint", "prettier", "ruff", "black", "gofmt", "git",
]);

/** Minimal shell tokenizer: splits on whitespace, honoring single/double quotes. */
export function tokenizeCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function baseName(tok: string): string {
  const s = tok.replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return (i >= 0 ? s.slice(i + 1) : s).replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/**
 * From a (possibly compound) command line, pick the most interesting simple
 * segment: prefer a segment whose executable is a recognized tool, else the first
 * segment. Handles `&&`, `||`, `;`, and `|` separators and `env VAR=x cmd` prefixes.
 */
export function pickPrimarySegment(cmd: string): { executable?: string; argv: string[] } {
  const segments = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).filter((s) => s.trim());
  let fallback: { executable?: string; argv: string[] } | null = null;
  for (const seg of segments) {
    let tokens = tokenizeCommand(seg);
    // Skip leading env-var assignments and an `env`/`sudo` prefix.
    while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!) || tokens[0] === "env" || tokens[0] === "sudo")) {
      tokens = tokens.slice(1);
    }
    if (!tokens.length) continue;
    const exe = baseName(tokens[0]!);
    const parsed = { executable: exe, argv: tokens.slice(1) };
    if (!fallback) fallback = parsed;
    if (RECOGNIZED_EXES.has(exe)) return parsed;
  }
  return fallback ?? { argv: [] };
}

/** Map a Claude hook event + tool to the normalized semantic phase. */
function phaseFor(hookEvent: string | undefined, tool: string | undefined): Phase {
  switch (hookEvent) {
    case "Stop":
      return "stop";
    case "SubagentStop":
      return "subagent";
    case "PreCompact":
      return "compact";
    case "SessionStart":
    case "UserPromptSubmit":
      return "prompt";
  }
  const t = (tool ?? "").toLowerCase();
  if (t === "bash" || t === "bashoutput") return "command";
  if (t === "read" || t === "glob" || t === "grep" || t === "notebookread") return "file_read";
  if (t === "edit" || t === "write" || t === "multiedit" || t === "notebookedit") return "file_write";
  return hookEvent === "PostToolUse" ? "post_tool" : "pre_tool";
}

/** Collect file paths + a short observational text cue from a tool_input object. */
function filesAndText(input: Record<string, unknown> | undefined): {
  files: Array<{ path: string }>;
  text?: string;
} {
  const files: Array<{ path: string }> = [];
  let text: string | undefined;
  if (!input) return { files };
  const fp = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof fp === "string" && fp.trim()) files.push({ path: fp });
  // Observational snippet for conservative token-cue extraction (never stored).
  const snippet =
    (typeof input.new_string === "string" && input.new_string) ||
    (typeof input.content === "string" && input.content) ||
    (typeof input.command === "string" && input.command) ||
    undefined;
  if (snippet) text = snippet;
  return { files, text };
}

/**
 * Convert one Claude hook payload into a normalized AgentEvent, or `null` when the
 * payload cannot be mapped. `seq` is the monotonic per-session sequence the caller
 * maintains. Never throws.
 */
export function claudeEventToAgentEvent(payload: ClaudeHookPayload, seq: number): AgentEvent | null {
  try {
    const sessionId = (payload.session_id ?? "unknown").toString().slice(0, 128) || "unknown";
    const tool = payload.tool_name;
    const phase = phaseFor(payload.hook_event_name, tool);
    const { files, text } = filesAndText(payload.tool_input);

    let command: AgentEvent["command"];
    if (tool && tool.toLowerCase() === "bash") {
      const cmdLine = typeof payload.tool_input?.command === "string" ? payload.tool_input.command : "";
      if (cmdLine) {
        const seg = pickPrimarySegment(cmdLine);
        command = { executable: seg.executable, argv: seg.argv };
      }
    }

    const raw = {
      host: "claude" as const,
      sessionId,
      seq,
      phase,
      tool,
      cwd: payload.cwd,
      files: files.length ? files : undefined,
      command,
      text,
    };
    return normalizeEvent(raw);
  } catch {
    return null;
  }
}
