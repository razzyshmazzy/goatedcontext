import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CtxContext } from "../core/context.ts";
import { installClaude, type ClaudeInstallResult } from "../adapters/claude/installer.ts";
import { captureChild, whichSync } from "../utils/runtime.ts";

/**
 * `ctx setup` / `goatedcontext setup` — one-command onboarding.
 *
 * Orchestrates the steps a new user would otherwise run by hand:
 *   1. initialize ~/.ctx (database, config, secret backend)
 *   2. make a persistent `ctx` available (global npm install) so it survives the
 *      temporary `npx` process that may have launched setup
 *   3. install the Claude Code adapter (skills, instruction block, prompt hook)
 *   4. verify a fresh process can actually run `ctx`
 *
 * It is pure orchestration over existing services — no new business logic — and is
 * idempotent: re-running repairs/verifies rather than duplicating anything.
 *
 * Every system-touching step (npm, PATH resolution, fresh-process verification) is
 * injectable so the whole flow can be unit-tested without mutating the machine.
 */

export type GlobalInstallOutcome = "installed" | "upgraded" | "present" | "skipped" | "failed";

export interface SetupResult {
  ok: boolean;
  home: string;
  secretBackend: string;
  secretSecure: boolean;
  skills: string[];
  instructionsAction: ClaudeInstallResult["instructionsAction"];
  hookAction: ClaudeInstallResult["hookAction"];
  hookCommand: string;
  globalInstall: GlobalInstallOutcome;
  globalBinDir: string | null;
  /** Absolute path of the persistent `ctx` launcher, if found. */
  ctxPath: string | null;
  /** Whether a brand-new shell would resolve `ctx` on PATH. */
  ctxResolvesOnPath: boolean;
  /** Whether a fresh process successfully ran `ctx --version`. */
  verified: boolean;
  warnings: string[];
}

export interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  /** The running CLI version (used to decide whether a global upgrade is needed). */
  version: string;
  claudeHome?: string;
  /** Skip making `ctx` globally persistent (advanced/manual installs). */
  skipGlobalInstall?: boolean;

  // ---- injectable seams (default to the real implementations) ----
  which?: (cmd: string, path?: string) => string | null;
  /** Directory holding global npm bins (default: derived from `npm prefix -g`). */
  globalBinDir?: string | null;
  /** Package directory to install globally (default: this package's root). */
  packageRoot?: string;
  installGlobal?: (packageRoot: string) => { ok: boolean; detail: string };
  verify?: (ctxPath: string) => { ok: boolean; version: string | null };
  installAdapter?: (args: { claudeHome?: string; hookCommand: string }) => ClaudeInstallResult;
}

function quoteCmd(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

/** Walk up from a file to the nearest directory containing package.json. */
function findPackageRoot(startFile: string): string | null {
  let dir = dirname(startFile);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolvePackageRoot(opts: SetupOptions): string {
  if (opts.packageRoot) return opts.packageRoot;
  const root = findPackageRoot(fileURLToPath(import.meta.url));
  if (!root) throw new Error("Could not locate the goatedcontext package directory to install.");
  return root;
}

/** Derive the global npm bin directory from `npm prefix -g`. */
function detectGlobalBinDir(env: NodeJS.ProcessEnv): string | null {
  const res = captureChild("npm", ["prefix", "-g"], { env });
  if (res.code !== 0) return null;
  const prefix = res.stdout.trim();
  if (!prefix) return null;
  // On Windows the shims live directly in the prefix; elsewhere in prefix/bin.
  return process.platform === "win32" ? prefix : join(prefix, "bin");
}

function installGlobalNpm(packageRoot: string, env: NodeJS.ProcessEnv): { ok: boolean; detail: string } {
  const res = captureChild("npm", ["install", "-g", packageRoot], { env });
  return { ok: res.code === 0, detail: (res.stderr || res.stdout).trim().slice(0, 400) };
}

function verifyCtx(ctxPath: string, env: NodeJS.ProcessEnv): { ok: boolean; version: string | null } {
  const res = captureChild(ctxPath, ["--version"], { env });
  const m = res.stdout.match(/\d+\.\d+\.\d+/);
  return { ok: res.code === 0 && m !== null, version: m ? m[0] : null };
}

function pathHint(dir: string, isWin: boolean): string {
  if (isWin) {
    return (
      `  PowerShell (user-scoped, no admin):\n` +
      `    [Environment]::SetEnvironmentVariable("Path", $env:Path + ";${dir}", "User")\n` +
      `  then open a new terminal.`
    );
  }
  return `  export PATH="$PATH:${dir}"   # add this to your ~/.bashrc or ~/.zshrc`;
}

export function runSetup(opts: SetupOptions): SetupResult {
  const env = opts.env ?? process.env;
  const which = opts.which ?? whichSync;
  const isWin = process.platform === "win32";
  const warnings: string[] = [];

  // 1. Initialize ~/.ctx (creates home, database, config; selects secret backend).
  const ctx = CtxContext.open(env);
  const home = ctx.paths.home;
  const secret = ctx.secrets.describe();
  ctx.close();

  // 2. Ensure a persistent global `ctx`.
  const globalBinDir = opts.globalBinDir === undefined ? detectGlobalBinDir(env) : opts.globalBinDir;
  const launcherName = isWin ? "ctx.cmd" : "ctx";
  const globalLauncher = globalBinDir ? join(globalBinDir, launcherName) : null;
  const verify = opts.verify ?? ((p: string) => verifyCtx(p, env));
  const doInstall = opts.installGlobal ?? ((root: string) => installGlobalNpm(root, env));

  let globalInstall: GlobalInstallOutcome;
  if (opts.skipGlobalInstall) {
    globalInstall = "skipped";
  } else {
    const existing = globalLauncher && existsSync(globalLauncher) ? globalLauncher : null;
    if (existing && verify(existing).version === opts.version) {
      globalInstall = "present"; // already persistent at this version
    } else {
      const res = doInstall(resolvePackageRoot(opts));
      globalInstall = res.ok ? (existing ? "upgraded" : "installed") : "failed";
      if (!res.ok) warnings.push(`Global install failed: ${res.detail || "unknown error"}`);
    }
  }

  // Resolve the persistent ctx path after any install.
  let ctxPath: string | null =
    globalLauncher && existsSync(globalLauncher) ? globalLauncher : which("ctx", env.PATH);

  // 3. Choose the hook command. Prefer the proven PATH-based form; fall back to an
  //    absolute path only when `ctx` would NOT resolve on PATH, so Claude's hook
  //    never ends up pointing at nothing.
  const onPath = Boolean(which("ctx", env.PATH));
  const hookCommand =
    onPath || !ctxPath ? "ctx hook claude-prompt" : `${quoteCmd(ctxPath)} hook claude-prompt`;

  // 4. Install/refresh the Claude adapter.
  const installAdapter = opts.installAdapter ?? installClaude;
  const install = installAdapter({ claudeHome: opts.claudeHome, hookCommand });

  // 5. Verify a fresh process can run the persistent ctx.
  let verified = false;
  if (ctxPath) {
    verified = verify(ctxPath).ok;
    if (!verified) warnings.push("The installed `ctx` did not respond to `ctx --version`.");
  } else if (!opts.skipGlobalInstall) {
    warnings.push("Could not locate a persistent `ctx` command after setup.");
  }

  // 6. Will a brand-new shell find `ctx`?
  const ctxResolvesOnPath = onPath;
  if (!ctxResolvesOnPath && !opts.skipGlobalInstall) {
    warnings.push(
      "`ctx` is not on your PATH yet — new terminals won't find it.\n" +
        (globalBinDir
          ? pathHint(globalBinDir, isWin)
          : "  Add your npm global bin directory (see `npm prefix -g`) to PATH."),
    );
  }

  const ok =
    install.hookAction !== "error" &&
    globalInstall !== "failed" &&
    (verified || ctxResolvesOnPath || opts.skipGlobalInstall === true);

  return {
    ok,
    home,
    secretBackend: secret.backend,
    secretSecure: secret.secure,
    skills: install.installedSkills,
    instructionsAction: install.instructionsAction,
    hookAction: install.hookAction,
    hookCommand,
    globalInstall,
    globalBinDir: globalBinDir ?? null,
    ctxPath,
    ctxResolvesOnPath,
    verified,
    warnings,
  };
}

function secretLabel(result: SetupResult): string {
  if (result.secretBackend === "windows-dpapi") return "Windows DPAPI";
  if (result.secretBackend === "encrypted-file") return "encrypted file (no OS keychain)";
  return result.secretBackend;
}

/** Render the short, friendly setup summary. */
export function renderSetup(result: SetupResult): string[] {
  const out: string[] = [];
  out.push("goatedcontext");
  out.push("");
  out.push("✓ initialized local context");
  out.push(`${result.skills.length > 0 ? "✓" : "✗"} installed Claude skills`);
  out.push(`${result.hookAction === "error" ? "✗" : "✓"} installed proactive retrieval hook`);
  out.push(`✓ secrets: ${secretLabel(result)}`);
  out.push("");

  if (result.warnings.length === 0 && result.ok) {
    out.push("Restart Claude Code.");
    out.push("");
    out.push("goat acquired.");
    return out;
  }

  if (result.hookAction === "error") {
    out.push("Your Claude settings.json is not valid JSON, so the hook was left untouched.");
    out.push("Fix it, then run: ctx install claude --repair");
    out.push("");
  }
  for (const w of result.warnings) out.push(w);
  if (result.ok) {
    out.push("");
    out.push("Restart Claude Code once the above is done.");
  }
  return out;
}
