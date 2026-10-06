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
import { detectClaudePermissions } from "../../adapters/claude/permissions.ts";
import { CTX_INSTRUCTION_BEGIN, CLAUDE_SKILLS } from "../../adapters/claude/skills.ts";
import { codexHome, codexHooksFile, detectCodexHook } from "../../adapters/codex/hook.ts";
import { codexSkillHealth, detectCodexRules } from "../../adapters/codex/installer.ts";
import { codexConfigFile, codexWritableRootConfigured } from "../../adapters/codex/config.ts";
import { resolvePaths } from "../../storage/paths.ts";
import { cursorSkillHealth } from "../../adapters/cursor/installer.ts";
import { AGENTS_BEGIN, AGENTS_END } from "../project/projection.ts";
import { skillHealth, type SkillHealth } from "../assets/skill-install.ts";
import { hasManagedBlock } from "../../utils/managed-block.ts";
import { gitToplevel } from "../../utils/git.ts";
import { whichSync } from "../../utils/runtime.ts";

const CONTEXT_LEARN_CONTENT = CLAUDE_SKILLS.find((s) => s.dir === "context-learn")!.content;

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
  /** Override the Cursor config dir (~/.cursor). */
  cursorHome?: string;
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
  /** The ctx memory-WRITE skill/guidance for this agent (teaches remember/propose/forget). */
  memorySkill: { installed: boolean; health: SkillHealth };
  /**
   * For sandboxed agents (Codex): whether the effective ctx home is configured as a
   * sandbox writable root, so a sandboxed memory write can reach the ctx database.
   * `null` for agents where this does not apply.
   */
  writableRootConfigured: boolean | null;
  /**
   * Whether the narrow ctx command permission rules (seamless memory writes) are
   * installed and current for this agent. `null` for agents where ctx does not (and
   * safely cannot) install a permission rule — e.g. Cursor, whose terminal allowlist
   * is injection-unsafe raw-prefix matching.
   */
  permissionsConfigured: boolean | null;
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
  const memHealth = skillHealth(home, "context-learn", CONTEXT_LEARN_CONTENT);
  const memorySkill = { installed: memHealth !== "missing", health: memHealth };
  const permissionsConfigured = (() => {
    try {
      return detectClaudePermissions(settings);
    } catch {
      return false;
    }
  })();
  const installed = hook || instructions || skills;
  const healthy = hook && instructions && skills && memHealth === "current" && permissionsConfigured;
  const notes: string[] = [];
  if (installed && !hook) notes.push("prompt hook missing (repair: ctx install claude --repair)");
  if (installed && !instructions) notes.push("instruction block missing");
  if (installed && !skills) notes.push("skills missing");
  if (installed && memHealth === "stale") notes.push("memory skill stale (repair: ctx install claude --repair)");
  if (installed && memHealth === "missing") notes.push("memory skill missing (repair: ctx install claude --repair)");
  if (installed && !permissionsConfigured) notes.push("ctx command permissions missing (repair: ctx install claude --repair)");
  return {
    id: "claude",
    label: LABELS.claude,
    capabilities: CLAUDE_CAPS,
    detected: existsSync(home),
    installed,
    healthy,
    staticPresent: false, // Claude is delivered at runtime; we don't project AGENTS.md for it
    configPath: home,
    memorySkill,
    writableRootConfigured: null, // Claude is not sandboxed by a writable-roots allowlist
    permissionsConfigured,
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
  const memHealth = codexSkillHealth(home);
  const memorySkill = { installed: memHealth !== "missing", health: memHealth };
  const ctxHome = resolvePaths(env).home;
  const writableRootConfigured = (() => {
    try {
      return codexWritableRootConfigured(codexConfigFile(home), ctxHome);
    } catch {
      return false;
    }
  })();
  const permissionsConfigured = (() => {
    try {
      return detectCodexRules(home);
    } catch {
      return false;
    }
  })();
  const anyInstalled = installed || memorySkill.installed;
  const notes: string[] = [];
  if (!anyInstalled && (existsSync(home) || onPath)) notes.push("not configured (run: ctx install codex)");
  if (anyInstalled && !installed) notes.push("prompt hook missing (repair: ctx repair codex)");
  if (anyInstalled && memHealth === "stale") notes.push("memory skill stale (repair: ctx repair codex)");
  if (anyInstalled && memHealth === "missing") notes.push("memory skill missing (repair: ctx repair codex)");
  if (anyInstalled && !writableRootConfigured)
    notes.push("ctx writable root missing (repair: ctx repair codex)");
  if (anyInstalled && !permissionsConfigured)
    notes.push("ctx command rules missing (repair: ctx repair codex)");
  return {
    id: "codex",
    label: LABELS.codex,
    capabilities: CODEX_CAPS,
    detected: existsSync(home) || onPath,
    installed: anyInstalled,
    healthy: installed && memHealth === "current" && permissionsConfigured,
    staticPresent: repoAgentsBlockPresent(opts.cwd ?? process.cwd()),
    configPath: home,
    memorySkill,
    writableRootConfigured,
    permissionsConfigured,
    version: null,
    notes,
  };
}

function cursorStatus(opts: AgentStatusOptions): AgentStatus {
  const cwd = opts.cwd ?? process.cwd();
  const globalDir = opts.cursorHome ?? join(homedir(), ".cursor");
  const repoRoot = (() => {
    try {
      return gitToplevel(cwd);
    } catch {
      return null;
    }
  })();
  const staticPresent = repoAgentsBlockPresent(cwd);
  const memHealth = cursorSkillHealth({ home: globalDir });
  const memorySkill = { installed: memHealth !== "missing", health: memHealth };
  // Cursor has two channels: the repo AGENTS.md (static READ) and the global memory
  // skill (WRITE). "installed" = either is present; "healthy" requires the write
  // skill current and, when in a repo, the static block present.
  const installed = staticPresent || memorySkill.installed;
  const healthy = memHealth === "current" && (repoRoot ? staticPresent : true);
  const notes = ["runtime injection unavailable (Cursor hooks cannot inject context)"];
  if (memHealth === "stale") notes.push("memory skill stale (repair: ctx repair cursor)");
  if (memHealth === "missing") notes.push("memory skill missing (run: ctx install cursor)");
  if (!staticPresent && repoRoot) notes.push("repo AGENTS.md not projected (run: ctx sync)");
  if (!repoRoot) notes.push("not inside a git repo — the repo AGENTS.md projection is repo-scoped");
  return {
    id: "cursor",
    label: LABELS.cursor,
    capabilities: CURSOR_CAPS,
    detected: existsSync(globalDir) || installed,
    installed,
    healthy,
    staticPresent,
    configPath: repoRoot ? join(repoRoot, "AGENTS.md") : globalDir,
    memorySkill,
    writableRootConfigured: null, // Cursor is not sandboxed by a writable-roots allowlist
    // Cursor's terminal allowlist is injection-unsafe raw-prefix matching, so ctx does
    // NOT install a permission rule there (spec §14/§21). Not applicable → null.
    permissionsConfigured: null,
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
