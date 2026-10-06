import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../../utils/fs.ts";
import { CTX_MEMORY_SKILL_NAME, ctxCommand, renderMemorySkill } from "../../core/assets/memory-protocol.ts";
import {
  upsertSkill,
  removeSkill,
  skillFile,
  skillHealth,
  type SkillAction,
  type SkillRemoveAction,
  type SkillHealth,
} from "../../core/assets/skill-install.ts";
import {
  cursorHooksFile,
  upsertCursorHook,
  removeCursorHook,
  detectCursorHook,
  type CursorHookAction,
} from "./hooks.ts";
import {
  cursorMcpFile,
  upsertCursorMcp,
  removeCursorMcp,
  detectCursorMcp,
  type CursorMcpAction,
} from "./mcp.ts";

/**
 * Install the goatedcontext Cursor MEMORY skill.
 *
 * Cursor adopts the Agent-Skills `SKILL.md` standard; the only file-based,
 * all-projects surface is a USER skill at `~/.cursor/skills/<name>/SKILL.md`
 * (global rules are UI-only, with no file path; `~/.cursor/rules/` is not read).
 * So the write protocol lives there, as a user skill Cursor auto-discovers from its
 * `description`.
 *
 * This is the WRITE channel and is independent of the repo `AGENTS.md` static READ
 * projection (`ctx sync`) — the protocol must NOT go in AGENTS.md (spec §17). Owns
 * ONLY its own `goatedcontext` skill dir; unrelated Cursor skills/rules are
 * preserved. Idempotent; `installCursorSkill` doubles as repair.
 *
 * Caveat (documented): user-level Cursor skills are local-editor only and do not
 * propagate to Cloud/background agents.
 */

export interface CursorInstallOptions {
  /** Root of the Cursor config dir. Defaults to `~/.cursor` (override for tests). */
  home?: string;
  /** Override the host platform (for deterministic tests). */
  platform?: NodeJS.Platform;
}

export interface CursorSkillResult {
  home: string;
  skillFile: string;
  skillAction: SkillAction;
}

export interface CursorUninstallResult {
  home: string;
  skillFile: string;
  skillAction: SkillRemoveAction;
}

export function cursorHome(opts: CursorInstallOptions = {}): string {
  return opts.home ?? join(homedir(), ".cursor");
}

export function installCursorSkill(opts: CursorInstallOptions = {}): CursorSkillResult {
  const home = cursorHome(opts);
  const platform = opts.platform ?? process.platform;
  mkdirSync(home, { recursive: true });
  const lockFile = join(home, ".ctx-install.lock");
  return withFileLock(lockFile, () => {
    const content = renderMemorySkill({ command: ctxCommand(platform) });
    const skillAction = upsertSkill(home, CTX_MEMORY_SKILL_NAME, content);
    return { home, skillFile: skillFile(home, CTX_MEMORY_SKILL_NAME), skillAction };
  });
}

/** Repair == install: converges the skill to the current protocol. */
export const repairCursorSkill = installCursorSkill;

export function uninstallCursorSkill(opts: CursorInstallOptions = {}): CursorUninstallResult {
  const home = cursorHome(opts);
  const file = skillFile(home, CTX_MEMORY_SKILL_NAME);
  if (!existsSync(home)) return { home, skillFile: file, skillAction: "absent" };
  const lockFile = join(home, ".ctx-install.lock");
  return withFileLock(lockFile, () => {
    const skillAction = removeSkill(home, CTX_MEMORY_SKILL_NAME);
    return { home, skillFile: file, skillAction };
  });
}

/** Health of the installed Cursor memory skill versus the current protocol (platform-aware). */
export function cursorSkillHealth(opts: CursorInstallOptions = {}): SkillHealth {
  const platform = opts.platform ?? process.platform;
  return skillHealth(cursorHome(opts), CTX_MEMORY_SKILL_NAME, renderMemorySkill({ command: ctxCommand(platform) }));
}

// ---- 0.4.0 runtime: sessionStart hook + MCP server --------------------------

/** The sessionStart hook command for Cursor (platform-aware launcher). */
export function cursorSessionHookCommand(platform: NodeJS.Platform = process.platform): string {
  return `${ctxCommand(platform)} hook cursor-session`;
}

export interface CursorRuntimeResult {
  home: string;
  hooksFile: string;
  hookAction: CursorHookAction;
  mcpFile: string;
  mcpAction: CursorMcpAction;
}

/**
 * Install/refresh Cursor's RUNTIME integration: a `sessionStart` hook that injects the
 * bootstrap context block, and an `mcp.json` stdio server entry for per-task retrieval
 * and memory writes. Surgical + idempotent; doubles as repair. Only ctx-owned entries
 * are touched.
 */
export function installCursorRuntime(opts: CursorInstallOptions = {}): CursorRuntimeResult {
  const home = cursorHome(opts);
  const platform = opts.platform ?? process.platform;
  mkdirSync(home, { recursive: true });
  const lockFile = join(home, ".ctx-install.lock");
  return withFileLock(lockFile, () => {
    const hookAction = upsertCursorHook(cursorHooksFile(home), cursorSessionHookCommand(platform));
    const mcpAction = upsertCursorMcp(cursorMcpFile(home), ctxCommand(platform), ["mcp"]);
    return {
      home,
      hooksFile: cursorHooksFile(home),
      hookAction,
      mcpFile: cursorMcpFile(home),
      mcpAction,
    };
  });
}

/** Remove ONLY ctx-owned Cursor runtime entries (hook + MCP server). */
export function uninstallCursorRuntime(opts: CursorInstallOptions = {}): CursorRuntimeResult {
  const home = cursorHome(opts);
  const hooksFile = cursorHooksFile(home);
  const mcpFile = cursorMcpFile(home);
  if (!existsSync(home)) {
    return { home, hooksFile, hookAction: "absent", mcpFile, mcpAction: "absent" };
  }
  const lockFile = join(home, ".ctx-install.lock");
  return withFileLock(lockFile, () => ({
    home,
    hooksFile,
    hookAction: removeCursorHook(hooksFile),
    mcpFile,
    mcpAction: removeCursorMcp(mcpFile),
  }));
}

/** Whether Cursor's ctx runtime (sessionStart hook + MCP server) is currently configured. */
export function cursorRuntimeStatus(opts: CursorInstallOptions = {}): { hook: boolean; mcp: boolean } {
  const home = cursorHome(opts);
  return { hook: detectCursorHook(cursorHooksFile(home)), mcp: detectCursorMcp(cursorMcpFile(home)) };
}
