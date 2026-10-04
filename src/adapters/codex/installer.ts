import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "../../utils/fs.ts";
import {
  CTX_MEMORY_SKILL_NAME,
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
}

export interface CodexInstallResult {
  home: string;
  hooksFile: string;
  hookAction: HookAction;
  skillFile: string;
  skillAction: SkillAction;
}

function resolveHome(opts: CodexInstallOptions): string {
  return opts.home ?? codexHome(opts.env ?? process.env);
}

export function installCodex(opts: CodexInstallOptions = {}): CodexInstallResult {
  const home = resolveHome(opts);
  mkdirSync(home, { recursive: true });
  const lockFile = join(home, ".ctx-install.lock");
  return withFileLock(lockFile, () => {
    const hooksFile = codexHooksFile(home);
    const hookAction = opts.disableHook
      ? removeCodexHook(hooksFile)
      : upsertCodexHook(hooksFile, opts.hookCommand ?? CODEX_HOOK_COMMAND_DEFAULT);
    const skillAction = upsertSkill(home, CTX_MEMORY_SKILL_NAME, renderMemorySkill());
    return { home, hooksFile, hookAction, skillFile: skillFile(home, CTX_MEMORY_SKILL_NAME), skillAction };
  });
}

/** Repair is identical to install: both converge to the desired hook + skill state. */
export const repairCodex = installCodex;

export interface CodexUninstallResult {
  home: string;
  hooksFile: string;
  hookAction: HookAction;
  skillAction: SkillRemoveAction;
}

/** Remove the goatedcontext Codex hook + memory skill. Repo AGENTS.md is left to `ctx sync --remove`. */
export function uninstallCodex(opts: CodexInstallOptions = {}): CodexUninstallResult {
  const home = resolveHome(opts);
  const hooksFile = codexHooksFile(home);
  if (!existsSync(home)) return { home, hooksFile, hookAction: "absent", skillAction: "absent" };
  const lockFile = join(home, ".ctx-install.lock");
  return withFileLock(lockFile, () => {
    const hookAction = removeCodexHook(hooksFile);
    const skillAction = removeSkill(home, CTX_MEMORY_SKILL_NAME);
    return { home, hooksFile, hookAction, skillAction };
  });
}

/** Health of the installed Codex memory skill versus the current protocol. */
export function codexSkillHealth(home: string): SkillHealth {
  return skillHealth(home, CTX_MEMORY_SKILL_NAME, renderMemorySkill());
}

export { detectCodexHook };
