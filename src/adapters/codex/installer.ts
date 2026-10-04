import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "../../utils/fs.ts";
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
 * Install the goatedcontext Codex adapter — the RUNTIME channel only.
 *
 * Codex gets its standing repo rules from the per-repo `AGENTS.md` written by
 * `ctx sync` (shared with Cursor); global `always` / `relevant` / matching
 * `conditional` reach Codex dynamically through a `UserPromptSubmit` hook in
 * `~/.codex/hooks.json` that calls `ctx hook codex-prompt`. Per the corrected
 * 0.2.9 policy we deliberately do NOT write a global `~/.codex/AGENTS.md`: a
 * personal/global preference must not be materialized into a static file.
 *
 * Owns ONLY its own hook entry; unrelated Codex hooks/config are preserved.
 * Idempotent and lock-guarded. `installCodex` doubles as repair (converges to the
 * desired state regardless of prior state).
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
    return { home, hooksFile, hookAction };
  });
}

/** Repair is identical to install: both converge to the desired hook state. */
export const repairCodex = installCodex;

export interface CodexUninstallResult {
  home: string;
  hooksFile: string;
  hookAction: HookAction;
}

/** Remove the goatedcontext Codex hook. Repo AGENTS.md (shared) is left to `ctx sync --remove`. */
export function uninstallCodex(opts: CodexInstallOptions = {}): CodexUninstallResult {
  const home = resolveHome(opts);
  const hooksFile = codexHooksFile(home);
  if (!existsSync(home)) return { home, hooksFile, hookAction: "absent" };
  const lockFile = join(home, ".ctx-install.lock");
  return withFileLock(lockFile, () => {
    const hookAction = removeCodexHook(hooksFile);
    return { home, hooksFile, hookAction };
  });
}

export { detectCodexHook };
