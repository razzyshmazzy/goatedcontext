import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentCapabilities,
  type AgentId,
  AGENT_IDS,
  capabilitiesFor,
} from "./capabilities.ts";
import { detectPromptHook } from "../../adapters/claude/hook.ts";
import { CTX_INSTRUCTION_BEGIN } from "../../adapters/claude/skills.ts";
import { codexHome, codexHooksFile, detectCodexHook } from "../../adapters/codex/hook.ts";
import { AGENTS_BEGIN, AGENTS_END } from "../project/projection.ts";
import { hasManagedBlock } from "../../utils/managed-block.ts";
import { gitToplevel } from "../../utils/git.ts";
import { whichSync } from "../../utils/runtime.ts";

/**
 * The agent registry: one clean place that knows the supported agents, their
 * capabilities, and how to DETECT their presence and ctx-integration health. The
 * CLI (`ctx agents`, `ctx doctor`, `ctx setup`) iterates this instead of hardcoding
 * per-agent branches. Lifecycle (install/repair/uninstall) still lives in the thin
 * adapters; the registry answers "what is here and is it healthy?".
 */

export interface AgentStatusOptions {
  env?: NodeJS.ProcessEnv;
  /** Working directory used to resolve the repo (Cursor static projection is repo-scoped). */
  cwd?: string;
  /** Override the Claude config dir (~/.claude). */
  claudeHome?: string;
  /** Override the Codex config dir ($CODEX_HOME or ~/.codex). */
  codexHome?: string;
}

export interface AgentStatus {
  id: AgentId;
  label: string;
  capabilities: AgentCapabilities;
  /** The agent itself appears present on this machine. Absence is normal, not an error. */
  detected: boolean;
  /** goatedcontext integration artifacts are present for this agent. */
  installed: boolean;
  /** The integration is complete and valid. */
  healthy: boolean;
  /** For AGENTS.md-aware agents: is the goatedcontext block present in this repo's AGENTS.md? */
  staticPresent: boolean;
  /** Where this agent's ctx-relevant config lives. */
  configPath: string;
  /** Agent version when cheaply available; otherwise null (we never spawn to find out). */
  version: string | null;
  /** Short, human-readable notes (missing pieces, honest limitations). */
  notes: string[];
}

export interface AgentDescriptor {
  id: AgentId;
  label: string;
  capabilities: AgentCapabilities;
  status(opts?: AgentStatusOptions): AgentStatus;
}

const LABELS: Record<AgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

function safeIncludes(file: string, needle: string): boolean {
  try {
    return existsSync(file) && readFileSync(file, "utf8").includes(needle);
  } catch {
    return false;
  }
}

/** Is the goatedcontext managed block present in the AGENTS.md of the repo at `cwd`? */
function repoAgentsBlockPresent(cwd: string): boolean {
  let root: string | null = null;
  try {
    root = gitToplevel(cwd);
  } catch {
    root = null;
  }
  if (!root) return false;
  return hasManagedBlock(join(root, "AGENTS.md"), AGENTS_BEGIN, AGENTS_END);
}

function claudeStatus(opts: AgentStatusOptions): AgentStatus {
  const home = opts.claudeHome ?? join(homedir(), ".claude");
  const settings = join(home, "settings.json");
  const hook = (() => {
    try {
      return detectPromptHook(settings);
    } catch {
      return false;
    }
  })();
  const instructions = safeIncludes(join(home, "CLAUDE.md"), CTX_INSTRUCTION_BEGIN);
  const skills = existsSync(join(home, "skills", "context", "SKILL.md"));
  const installed = hook || instructions || skills;
  const healthy = hook && instructions && skills;
  const notes: string[] = [];
  if (installed && !hook) notes.push("prompt hook missing (repair: ctx install claude --repair)");
  if (installed && !instructions) notes.push("instruction block missing");
  if (installed && !skills) notes.push("skills missing");
  return {
    id: "claude",
    label: LABELS.claude,
    capabilities: CLAUDE_CAPS,
    detected: existsSync(home),
    installed,
    healthy,
    staticPresent: false, // Claude is delivered at runtime; we don't project AGENTS.md for it
    configPath: home,
    version: null,
    notes,
  };
}

function codexStatus(opts: AgentStatusOptions): AgentStatus {
  const env = opts.env ?? process.env;
  const home = opts.codexHome ?? codexHome(env);
  const hooksFile = codexHooksFile(home);
  const installed = (() => {
    try {
      return detectCodexHook(hooksFile);
    } catch {
      return false;
    }
  })();
  const onPath = (() => {
    try {
      return whichSync("codex") !== null;
    } catch {
      return false;
    }
  })();
  const notes: string[] = [];
  if (!installed && (existsSync(home) || onPath)) notes.push("not configured (run: ctx install codex)");
  return {
    id: "codex",
    label: LABELS.codex,
    capabilities: CODEX_CAPS,
    detected: existsSync(home) || onPath,
    installed,
    healthy: installed,
    staticPresent: repoAgentsBlockPresent(opts.cwd ?? process.cwd()),
    configPath: home,
    version: null,
    notes,
  };
}

function cursorStatus(opts: AgentStatusOptions): AgentStatus {
  const cwd = opts.cwd ?? process.cwd();
  const globalDir = join(homedir(), ".cursor");
  const repoRoot = (() => {
    try {
      return gitToplevel(cwd);
    } catch {
      return null;
    }
  })();
  const staticPresent = repoAgentsBlockPresent(cwd);
  const installed = staticPresent; // Cursor's only channel is the repo AGENTS.md block
  const notes = ["runtime injection unavailable (Cursor hooks cannot inject context)"];
  if (!installed && repoRoot) notes.push("not projected into this repo (run: ctx install cursor)");
  if (!repoRoot) notes.push("not inside a git repo — Cursor static projection is repo-scoped");
  return {
    id: "cursor",
    label: LABELS.cursor,
    capabilities: CURSOR_CAPS,
    detected: existsSync(globalDir) || installed,
    installed,
    healthy: installed,
    staticPresent,
    configPath: repoRoot ? join(repoRoot, "AGENTS.md") : globalDir,
    version: null,
    notes,
  };
}

const CLAUDE_CAPS = capabilitiesFor("claude");
const CODEX_CAPS = capabilitiesFor("codex");
const CURSOR_CAPS = capabilitiesFor("cursor");

const STATUS_FNS: Record<AgentId, (opts: AgentStatusOptions) => AgentStatus> = {
  claude: claudeStatus,
  codex: codexStatus,
  cursor: cursorStatus,
};

export function getAgent(id: AgentId): AgentDescriptor {
  return {
    id,
    label: LABELS[id],
    capabilities: capabilitiesFor(id),
    status: (opts: AgentStatusOptions = {}) => STATUS_FNS[id](opts),
  };
}

export function allAgents(): AgentDescriptor[] {
  return AGENT_IDS.map(getAgent);
}

/** Status for every supported agent, for `ctx agents` / `ctx doctor` / `ctx setup`. */
export function agentStatuses(opts: AgentStatusOptions = {}): AgentStatus[] {
  return allAgents().map((a) => a.status(opts));
}
