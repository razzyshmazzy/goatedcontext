import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CtxContext } from "../core/context.ts";
import { installClaude, type ClaudeInstallResult } from "../adapters/claude/installer.ts";
import { captureChild, persistentPath, whichSync } from "../utils/runtime.ts";

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
  /**
   * Whether the PERSISTENT `ctx` (the one the user's shell resolves, or the global
   * launcher for a fresh install) was confirmed to report the exact running
   * version after install. This is the real success signal — never the npx
   * process's own version, and never merely npm's exit code.
   */
  verified: boolean;
  /** The running package version this setup is installing (single source of truth). */
  runningVersion: string;
  /** Version the persistent launcher reported BEFORE install (null if none). */
  previousVersion: string | null;
  /** Version the persistent launcher reports AFTER install (null if unresolved). */
  installedVersion: string | null;
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
  // Install the EXACT package this process is running from (a directory spec), so
  // `npx goatedcontext@X setup` persists exactly version X — never an implicit
  // `latest` or a bare package name. Surface npm's own stderr on failure rather
  // than swallowing it, so a broken install produces actionable diagnostics.
  const res = captureChild("npm", ["install", "-g", packageRoot], { env });
  const detail = (res.stderr.trim() || res.stdout.trim()).slice(0, 2000);
  return { ok: res.code === 0, detail };
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

  // 2. Ensure a persistent global `ctx` at the EXACT running version.
  const runningVersion = opts.version;
  const globalBinDir = opts.globalBinDir === undefined ? detectGlobalBinDir(env) : opts.globalBinDir;
  const launcherName = isWin ? "ctx.cmd" : "ctx";
  const globalLauncher = globalBinDir ? join(globalBinDir, launcherName) : null;
  const verify = opts.verify ?? ((p: string) => verifyCtx(p, env));
  const doInstall = opts.installGlobal ?? ((root: string) => installGlobalNpm(root, env));

  /** Version reported by a launcher path, or null if absent/unrunnable. */
  const versionOf = (p: string | null): string | null => {
    if (!p || !existsSync(p)) return null;
    return verify(p).version;
  };

  // Resolve `ctx` against the PERSISTENT PATH — env.PATH with ephemeral entries
  // stripped. This is critical when setup is launched via `npx goatedcontext setup`:
  // npm prepends the npx cache's `node_modules/.bin` (holding a `ctx` shim for the
  // just-downloaded package, at the running version) to this process's PATH. Reading
  // the RAW PATH would resolve that ephemeral shim and wrongly conclude the user is
  // "already current" while their real shell still runs the old global launcher.
  const persistPath = persistentPath(env.PATH);

  // The version the persistent launcher reports BEFORE we touch it. Prefer the
  // launcher the user's shell actually resolves (`ctx` on the persistent PATH); fall
  // back to the npm global-prefix launcher. This makes "upgraded 0.2.3 → 0.2.6" honest.
  const preOnPath = which("ctx", persistPath);
  const previousVersion = versionOf(preOnPath) ?? versionOf(globalLauncher);

  let globalInstall: GlobalInstallOutcome;
  let installFailed = false;
  if (opts.skipGlobalInstall) {
    globalInstall = "skipped";
  } else if (previousVersion === runningVersion) {
    globalInstall = "present"; // already persistent at the exact running version
  } else {
    const res = doInstall(resolvePackageRoot(opts));
    if (!res.ok) {
      installFailed = true;
      globalInstall = "failed";
      warnings.push(`npm global install failed:\n${res.detail || "unknown error"}`);
    } else {
      globalInstall = previousVersion ? "upgraded" : "installed";
    }
  }

  // 3. VERIFY the persistent CLI in a fresh process — the real success signal.
  //    We deliberately do NOT trust this npx process's own version, nor npm's exit
  //    code alone, nor an ephemeral npx shim on the raw PATH. We run the launcher the
  //    user's shell resolves (persistent PATH) and the global prefix launcher, and
  //    require the reported version to equal runningVersion.
  const postOnPath = which("ctx", persistPath);
  const persistentCtx = postOnPath ?? (globalLauncher && existsSync(globalLauncher) ? globalLauncher : null);
  const ctxResolvesOnPath = Boolean(postOnPath);

  const pathVersion = versionOf(postOnPath);
  const prefixVersion = versionOf(globalLauncher);
  const installedVersion = pathVersion ?? prefixVersion;

  let verified = false;
  if (opts.skipGlobalInstall) {
    verified = true; // advanced/manual path: nothing for us to verify
  } else if (!installFailed) {
    verified = installedVersion === runningVersion;
    if (!verified) {
      if (!persistentCtx) {
        warnings.push(
          `Could not locate a persistent \`ctx\` after install.\n` +
            (globalBinDir
              ? `  Expected it in ${globalBinDir}. Check \`npm prefix -g\` and your PATH.`
              : "  Check `npm prefix -g` and your PATH."),
        );
      } else if (pathVersion && prefixVersion === runningVersion && pathVersion !== runningVersion) {
        // Installed correctly at the npm prefix, but an OLDER shim shadows it on PATH.
        warnings.push(
          `An older \`ctx\` on your PATH is shadowing the updated one:\n` +
            `  active:  ${postOnPath} → ${pathVersion}\n` +
            `  updated: ${globalLauncher} → ${prefixVersion}\n` +
            `  Fix: put ${globalBinDir} ahead on PATH, or delete the stale launcher above, then reopen your terminal.`,
        );
      } else {
        // npm reported success but the persistent launcher isn't at the running version:
        // npm's global prefix likely differs from where `ctx` resolves.
        warnings.push(
          `\`ctx\` still reports ${installedVersion ?? "no version"} after installing ${runningVersion}.\n` +
            `  persistent: ${persistentCtx}\n` +
            `  npm global prefix: ${globalBinDir ?? "(unknown)"}\n` +
            `  npm may be installing to a different prefix than the \`ctx\` on your PATH (a Node version\n` +
            `  manager, or a per-machine vs per-user npm). Ensure they match, then rerun \`npx goatedcontext setup\`.`,
        );
      }
    }
  }

  // 4. Choose the hook command. Prefer the proven PATH-based form; fall back to an
  //    absolute path only when `ctx` would NOT resolve on PATH, so Claude's hook
  //    never ends up pointing at nothing.
  const ctxPath = persistentCtx;
  const hookCommand =
    ctxResolvesOnPath || !ctxPath ? "ctx hook claude-prompt" : `${quoteCmd(ctxPath)} hook claude-prompt`;

  // 5. Install/refresh the Claude adapter (idempotent — skills, instruction block, hook).
  const installAdapter = opts.installAdapter ?? installClaude;
  const install = installAdapter({ claudeHome: opts.claudeHome, hookCommand });

  // 6. Will a brand-new shell find `ctx`? (Only a hint; not a failure on its own
  //    when we verified the launcher by absolute path — e.g. a first install
  //    before PATH is refreshed.)
  if (!ctxResolvesOnPath && !opts.skipGlobalInstall && !installFailed) {
    warnings.push(
      "`ctx` is not on your PATH yet — new terminals won't find it.\n" +
        (globalBinDir
          ? pathHint(globalBinDir, isWin)
          : "  Add your npm global bin directory (see `npm prefix -g`) to PATH."),
    );
  }

  const ok = install.hookAction !== "error" && globalInstall !== "failed" && verified;

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
    runningVersion,
    previousVersion,
    installedVersion,
    warnings,
  };
}

/** The CLI-line describing the global install outcome (requirement 2). */
function globalLine(result: SetupResult): string {
  const v = result.runningVersion;
  switch (result.globalInstall) {
    case "installed":
      return `✓ installed ctx ${v}`;
    case "upgraded":
      return `✓ upgraded ctx ${result.previousVersion ?? "?"} → ${v}`;
    case "present":
      return `✓ ctx already current (${v})`;
    case "skipped":
      return `✓ ctx (global install skipped)`;
    case "failed":
      return `✗ failed to install ctx ${v}`;
  }
}

/**
 * Render the short, friendly setup summary. Success stays to a few lines and never
 * shows npm internals; failure surfaces the exact diagnostics (incl. npm stderr).
 */
export function renderSetup(result: SetupResult): string[] {
  const out: string[] = [];
  out.push("goatedcontext");

  if (result.ok && result.warnings.length === 0) {
    const firstInstall = result.globalInstall === "installed";
    out.push(globalLine(result));
    out.push(firstInstall ? "✓ initialized local context" : "✓ preserved local context");
    out.push(
      result.globalInstall === "installed"
        ? "✓ installed Claude integration"
        : "✓ refreshed Claude integration",
    );
    out.push("");
    out.push("Restart Claude Code.");
    if (result.globalInstall === "upgraded") out.push("goat upgraded.");
    else if (result.globalInstall === "present") out.push("goat already current.");
    else out.push("goat acquired.");
    return out;
  }

  // Something needs attention: be explicit, keep the surviving good news, and show
  // the actionable diagnostics (which include npm stderr on a failed install).
  out.push(globalLine(result));
  if (result.hookAction === "error") {
    out.push("✗ Claude settings.json is not valid JSON — the hook was left untouched.");
    out.push("  Fix it, then run: ctx install claude --repair");
  } else if (result.skills.length > 0) {
    out.push("✓ refreshed Claude integration");
  }
  out.push("");
  for (const w of result.warnings) out.push(w);
  if (result.ok) {
    out.push("");
    out.push("Restart Claude Code once the above is done.");
  }
  return out;
}
