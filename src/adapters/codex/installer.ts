import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "../../utils/fs.ts";
import { resolvePaths } from "../../storage/paths.ts";
import {
  CTX_MEMORY_SKILL_NAME,
  ctxCommand,
  renderMemorySkill,
} from "../../core/assets/memory-protocol.ts";
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
  codexHome,
  codexHooksFile,
  upsertCodexHook,
  removeCodexHook,
  detectCodexHook,
  CODEX_HOOK_COMMAND_DEFAULT,
  type HookAction,
} from "./hook.ts";
import {
  codexConfigFile,
  ensureCodexWritableRoot,
  type WritableRootAction,
} from "./config.ts";
import {
  upsertCodexRules,
  removeCodexRules,
  codexRulesFile,
  type PermissionAction,
} from "./permissions.ts";

/**
 * Install the goatedcontext Codex adapter. Two native channels:
 *   - RUNTIME read: a `UserPromptSubmit` hook in `~/.codex/hooks.json`
 *     (`ctx hook codex-prompt`) that injects relevant preferences per prompt.
 *   - MEMORY WRITE: a standalone SKILL.md at `$CODEX_HOME/skills/goatedcontext/`
 *     teaching the canonical remember/propose/forget protocol, so Codex writes
 *     durable preferences back without the user running `ctx` by hand.
 *
 * (Codex's current skills root is `~/.agents/skills`; `$CODEX_HOME/skills` is
 * deprecated-but-supported and is what this release targets per spec. Repo rules
 * still come from the shared `AGENTS.md` written by `ctx sync`; no global
 * `~/.codex/AGENTS.md` is written.)
 *
 * Owns ONLY its own hook entry and its own `goatedcontext` skill dir; unrelated
 * Codex hooks/config/skills are preserved. Idempotent and lock-guarded.
 * `installCodex` doubles as repair (converges to the desired state).
 */

export interface CodexInstallOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  hookCommand?: string;
  /** Remove (instead of install) the runtime hook — e.g. static-only setups. */
  disableHook?: boolean;
  /** Override the effective ctx home (defaults to the shared CTX_HOME resolver). */
  ctxHome?: string;
  /** Override the host platform (for deterministic tests). */
  platform?: NodeJS.Platform;
}

export interface CodexInstallResult {
  home: string;
  hooksFile: string;
  hookAction: HookAction;
  skillFile: string;
  skillAction: SkillAction;
  /** The Codex config file whose writable_roots were converged. */
  configFile: string;
  /** Outcome of ensuring the effective ctx home is a sandbox writable root. */
  writableRootAction: WritableRootAction;
  /** The effective ctx home granted as a writable root. */
  ctxHome: string;
  /** The goatedcontext-owned execpolicy rules file granting seamless ctx commands. */
  rulesFile: string;
  /** Outcome of installing the narrow ctx command auto-approval rules. */
  permissionAction: PermissionAction;
}

function resolveHome(opts: CodexInstallOptions): string {
  return opts.home ?? codexHome(opts.env ?? process.env);
}

/** The effective ctx home, via the SAME resolver ctx itself uses at runtime. */
function resolveCtxHome(opts: CodexInstallOptions): string {
  return opts.ctxHome ?? resolvePaths(opts.env ?? process.env).home;
}

export function installCodex(opts: CodexInstallOptions = {}): CodexInstallResult {
  const home = resolveHome(opts);
  const platform = opts.platform ?? process.platform;
  const ctxHome = resolveCtxHome(opts);
  mkdirSync(home, { recursive: true });
  const lockFile = join(home, ".ctx-install.lock");
  return withFileLock(lockFile, () => {
    const hooksFile = codexHooksFile(home);
    const hookAction = opts.disableHook
      ? removeCodexHook(hooksFile)
      : upsertCodexHook(hooksFile, opts.hookCommand ?? CODEX_HOOK_COMMAND_DEFAULT);
    const content = renderMemorySkill({ command: ctxCommand(platform) });
    const skillAction = upsertSkill(home, CTX_MEMORY_SKILL_NAME, content);
    // Grant the ctx home as a sandbox writable root so a sandboxed Codex child can
    // persist preferences (the ctx DB lives outside the repo). Least-privilege: ONLY
    // the ctx home, never a broader directory. A malformed/unmergeable config is left
    // untouched and reported — ctx itself still installs fine.
    const configFile = codexConfigFile(home);
    const { action: writableRootAction } = ensureCodexWritableRoot(configFile, ctxHome, platform);
    // Narrow, argv-based auto-approval for the safe ctx commands, in our OWN rules
    // file (never config.toml). Orthogonal to writable_roots above — both are needed:
    // the rule skips the approval prompt, writable_roots lets the sandboxed write land.
    const permissionAction = upsertCodexRules(home, platform);
    return {
      home,
      hooksFile,
      hookAction,
      skillFile: skillFile(home, CTX_MEMORY_SKILL_NAME),
      skillAction,
      configFile,
      writableRootAction,
      ctxHome,
      rulesFile: codexRulesFile(home),
      permissionAction,
    };
  });
}

/** Repair is identical to install: both converge to the desired hook + skill state. */
export const repairCodex = installCodex;

export interface CodexUninstallResult {
  home: string;
  hooksFile: string;
  hookAction: HookAction;
  skillAction: SkillRemoveAction;
  /** Outcome of removing the goatedcontext-owned execpolicy rules file. */
  permissionAction: PermissionAction;
}

/**
 * Remove the goatedcontext Codex hook + memory skill. Repo AGENTS.md is left to
 * `ctx sync --remove`.
 *
 * Ownership decision (spec §15): we deliberately DO NOT strip the ctx writable root
 * from `config.toml` on uninstall. A `writable_roots` entry equal to the ctx home
 * could just as plausibly be one the user added themselves; removing it on path
 * equality alone risks revoking a permission they wanted. We prefer safety over
 * perfect cleanup and leave the (inert, least-privilege) entry in place.
 */
export function uninstallCodex(opts: CodexInstallOptions = {}): CodexUninstallResult {
  const home = resolveHome(opts);
  const hooksFile = codexHooksFile(home);
  if (!existsSync(home))
    return { home, hooksFile, hookAction: "absent", skillAction: "absent", permissionAction: "absent" };
  const lockFile = join(home, ".ctx-install.lock");
  return withFileLock(lockFile, () => {
    const hookAction = removeCodexHook(hooksFile);
    const skillAction = removeSkill(home, CTX_MEMORY_SKILL_NAME);
    // Remove ONLY our own rules file. config.toml (writable_roots) is left intact —
    // same conservative ownership policy as the writable root itself (spec §18).
    const permissionAction = removeCodexRules(home);
    return { home, hooksFile, hookAction, skillAction, permissionAction };
  });
}

/** Health of the installed Codex memory skill versus the current protocol (platform-aware). */
export function codexSkillHealth(home: string, platform: NodeJS.Platform = process.platform): SkillHealth {
  return skillHealth(home, CTX_MEMORY_SKILL_NAME, renderMemorySkill({ command: ctxCommand(platform) }));
}

export { detectCodexHook };
export { detectCodexRules, codexRulesHealth, codexRulesFile } from "./permissions.ts";
