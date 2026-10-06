import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CtxContext } from "../core/context.ts";
import { installClaude, type ClaudeInstallResult } from "../adapters/claude/installer.ts";
import { installCodex } from "../adapters/codex/installer.ts";
import { installCursorSkill } from "../adapters/cursor/installer.ts";
import { syncProject } from "../core/project/sync.ts";
import { agentStatuses } from "../core/agents/registry.ts";
import type { AgentId } from "../core/agents/capabilities.ts";
import {
  captureChild,
  persistentPath,
  resolvesIntoEphemeralCache,
  whichSync,
} from "../utils/runtime.ts";

/**
 * `ctx setup` / `goatedcontext setup` — one-command onboarding.
 *
 * Orchestrates the steps a new user would otherwise run by hand:
 *   1. initialize ~/.ctx (database, config, secret backend)
 *   2. make a persistent `ctx` available by installing the EXACT published version
 *      from the npm registry (`goatedcontext@<version>`) so it survives the temporary
 *      `npx` process that launched setup — and never LINKS back into the npx cache
 *   3. install the Claude Code adapter (skills, instruction block, prompt hook)
 *   4. verify a fresh process can actually run `ctx`
 *
 * It is pure orchestration over existing services — no new business logic — and is
 * idempotent: re-running repairs/verifies rather than duplicating anything.
 *
 * Every system-touching step (npm, PATH resolution, fresh-process verification, link
 * inspection) is injectable so the whole flow can be unit-tested without mutating the
 * machine.
 *
 * ── Why we install a registry spec, not a directory ──────────────────────────────
 * `npx goatedcontext setup` runs from `.../npm-cache/_npx/<hash>/node_modules/
 * goatedcontext`. Installing THAT directory (`npm install -g <dir>`) makes npm LINK
 * the global package back into the ephemeral npx cache — so the "persistent" CLI
 * depends on a directory npm may purge at any time (the real 0.2.3 breakage). Setup
 * therefore installs `goatedcontext@<version>`, producing a normal, self-contained
 * global package. Tests inject a `.tgz` spec to exercise the same install semantics
 * without the registry.
 */

export type GlobalInstallOutcome =
  | "installed"
  | "upgraded"
  | "repaired"
  | "present"
  | "skipped"
  | "failed";

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
  /** The global package directory inspected for a broken (linked) install. */
  globalPackageDir: string | null;
  /**
   * Whether the PRE-EXISTING global package resolved into an ephemeral npm cache
   * (a symlink/junction into `_npx`) — the deeper 0.2.3 breakage. When true, setup
   * reinstalls from the registry even if the reported version already matched.
   */
  previousInstallLinked: boolean;
  /** The install spec used (registry `goatedcontext@<v>` in production, `.tgz` in tests). */
  installSpec: string;
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
  /** Agents detected and configured/repaired this run (0.2.9 auto-detection). */
  agentsConfigured: AgentId[];
  /** Per-configured-agent one-line outcome, for concise rendering. */
  agentLines: string[];
}

export interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  /** The running CLI version (used to decide whether a global upgrade is needed). */
  version: string;
  claudeHome?: string;
  /** Override the Codex config dir ($CODEX_HOME or ~/.codex). */
  codexHome?: string;
  /** Override the Cursor config dir (~/.cursor). */
  cursorHome?: string;
  /** Working directory used to resolve the repo for Codex/Cursor static projection. */
  cwd?: string;
  /**
   * Detect which supported agents (Claude/Codex/Cursor) are present and
   * configure/repair each. Off by default so unit tests exercise the global-install
   * + Claude path in isolation; the production `ctx setup` CLI turns it on.
   */
  autoDetectAgents?: boolean;
  /** Skip making `ctx` globally persistent (advanced/manual installs). */
  skipGlobalInstall?: boolean;

  /**
   * The npm spec to install globally. Production MUST leave this undefined so it
   * defaults to the registry spec `goatedcontext@<version>` — never a directory,
   * which is what created linked-into-`_npx` global installs. Tests may pass an
   * absolute `.tgz` path to exercise real package-install semantics offline.
   */
  installSpec?: string;

  // ---- injectable seams (default to the real implementations) ----
  which?: (cmd: string, path?: string) => string | null;
  /** Directory holding global npm bins (default: derived from `npm prefix -g`). */
  globalBinDir?: string | null;
  /** The global package directory (`<prefix>/node_modules/goatedcontext`, etc.). */
  globalPackageDir?: string | null;
  installGlobal?: (spec: string) => { ok: boolean; detail: string };
  verify?: (ctxPath: string) => { ok: boolean; version: string | null };
  /** Inspect the global package dir for a symlink/junction into an ephemeral cache. */
  inspectLink?: (packageDir: string) => { linked: boolean; target: string | null };
  installAdapter?: (args: { claudeHome?: string; hookCommand: string }) => ClaudeInstallResult;
}

function quoteCmd(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

interface GlobalPaths {
  /** Directory holding the global `ctx` launcher shims. */
  binDir: string;
  /** Directory of the installed global package (for link inspection). */
  packageDir: string;
}

/**
 * Derive the global npm bin AND package directories from `npm prefix -g`.
 *   - Windows: bins live in `<prefix>`, packages in `<prefix>/node_modules/<pkg>`.
 *   - POSIX:   bins live in `<prefix>/bin`, packages in `<prefix>/lib/node_modules/<pkg>`.
 */
function detectGlobalPaths(env: NodeJS.ProcessEnv): GlobalPaths | null {
  const res = captureChild("npm", ["prefix", "-g"], { env });
  if (res.code !== 0) return null;
  const prefix = res.stdout.trim();
  if (!prefix) return null;
  return process.platform === "win32"
    ? { binDir: prefix, packageDir: join(prefix, "node_modules", "goatedcontext") }
    : { binDir: join(prefix, "bin"), packageDir: join(prefix, "lib", "node_modules", "goatedcontext") };
}

/**
 * The production install spec: the EXACT published version from the registry. Never a
 * directory (which npm would link — see the file header) and never a bare name or an
 * implicit `latest` (which would drift from the running version).
 */
function productionInstallSpec(version: string): string {
  return `goatedcontext@${version}`;
}

function installGlobalNpm(spec: string, env: NodeJS.ProcessEnv): { ok: boolean; detail: string } {
  // `npm install -g goatedcontext@<version>` (or, in tests, an absolute .tgz path).
  // Both produce a real, self-contained global package. Surface npm's own stderr on
  // failure rather than swallowing it, so a broken install stays actionable.
  const res = captureChild("npm", ["install", "-g", spec], { env });
  const detail = (res.stderr.trim() || res.stdout.trim()).slice(0, 2000);
  return { ok: res.code === 0, detail };
}

/**
 * Inspect the global package directory for a BROKEN linked install: a symlink/junction
 * (npm links local-dir installs this way) or a real path that resolves into an
 * ephemeral npm cache (`_npx`). Robust across platforms — junctions are reported as
 * symlinks by `lstat` on Windows, and the realpath check catches anything lstat misses.
 * Never throws; an uninspectable path is simply "not linked".
 */
function inspectGlobalLink(packageDir: string): { linked: boolean; target: string | null } {
  try {
    if (!existsSync(packageDir)) return { linked: false, target: null };
    const isLink = lstatSync(packageDir).isSymbolicLink();
    let target: string | null = null;
    try {
      target = realpathSync(packageDir);
    } catch {
      target = null;
    }
    const escapes = target !== null && resolvesIntoEphemeralCache(target);
    return { linked: isLink || escapes, target };
  } catch {
    return { linked: false, target: null };
  }
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

  // 2. Ensure a persistent global `ctx` at the EXACT running version, installed as a
  //    real registry package (never linked into the npx cache).
  const runningVersion = opts.version;
  const needsDetect = opts.globalBinDir === undefined || opts.globalPackageDir === undefined;
  const detected = needsDetect ? detectGlobalPaths(env) : null;
  const globalBinDir = opts.globalBinDir === undefined ? (detected?.binDir ?? null) : opts.globalBinDir;
  const globalPackageDir =
    opts.globalPackageDir === undefined ? (detected?.packageDir ?? null) : opts.globalPackageDir;
  const launcherName = isWin ? "ctx.cmd" : "ctx";
  const globalLauncher = globalBinDir ? join(globalBinDir, launcherName) : null;
  const verify = opts.verify ?? ((p: string) => verifyCtx(p, env));
  const doInstall = opts.installGlobal ?? ((spec: string) => installGlobalNpm(spec, env));
  const inspectLink = opts.inspectLink ?? inspectGlobalLink;
  const installSpec = opts.installSpec ?? productionInstallSpec(runningVersion);

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

  // Detect the deeper 0.2.3 breakage: a global package that is a symlink/junction into
  // the ephemeral npx cache. Such an install is BROKEN even if `ctx --version` happens
  // to match, so we must reinstall it as a real package regardless of version.
  const preLink = globalPackageDir ? inspectLink(globalPackageDir) : { linked: false, target: null };
  const previousInstallLinked = preLink.linked;

  let globalInstall: GlobalInstallOutcome;
  let installFailed = false;
  if (opts.skipGlobalInstall) {
    globalInstall = "skipped";
  } else if (previousInstallLinked) {
    // Broken linked install → reinstall as a real registry package (repair).
    const res = doInstall(installSpec);
    if (!res.ok) {
      installFailed = true;
      globalInstall = "failed";
      warnings.push(`npm global install failed:\n${res.detail || "unknown error"}`);
    } else {
      globalInstall = "repaired";
    }
  } else if (previousVersion === runningVersion) {
    globalInstall = "present"; // already a real package at the exact running version
  } else {
    const res = doInstall(installSpec);
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

  // Re-inspect after install: a correct repair must leave a REAL package directory —
  // never still a link into the npx cache.
  const postLink = globalPackageDir ? inspectLink(globalPackageDir) : { linked: false, target: null };

  let verified = false;
  if (opts.skipGlobalInstall) {
    verified = true; // advanced/manual path: nothing for us to verify
  } else if (!installFailed) {
    verified = installedVersion === runningVersion && !postLink.linked;
    if (!verified) {
      if (postLink.linked) {
        // npm reported success but the global package still resolves into an ephemeral
        // cache — the install must be a real package, not a link.
        warnings.push(
          `The global \`goatedcontext\` still resolves into an ephemeral npm cache:\n` +
            `  package: ${globalPackageDir}\n` +
            `  resolves to: ${postLink.target ?? "(unknown)"}\n` +
            `  A persistent CLI must not depend on an \`_npx\` cache. Reinstall with:\n` +
            `    npm install -g goatedcontext@${runningVersion}`,
        );
      } else if (!persistentCtx) {
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

  // 5. Configure the detected agent integrations (idempotent). Without
  //    auto-detection (unit tests / explicit flows) Claude is always configured, as
  //    before. With auto-detection (production `ctx setup`) we touch ONLY agents
  //    actually present — an absent agent is never configured and never an error.
  const cwd = opts.cwd ?? process.cwd();
  const auto = Boolean(opts.autoDetectAgents);
  const detectedAgents = new Set<AgentId>(
    auto
      ? agentStatuses({ env, cwd, claudeHome: opts.claudeHome, codexHome: opts.codexHome, cursorHome: opts.cursorHome })
          .filter((s) => s.detected)
          .map((s) => s.id)
      : [],
  );
  const agentsConfigured: AgentId[] = [];
  const agentLines: string[] = [];

  const installAdapter = opts.installAdapter ?? installClaude;
  const configureClaude = !auto || detectedAgents.has("claude");
  let install: ClaudeInstallResult | null = null;
  if (configureClaude) {
    install = installAdapter({ claudeHome: opts.claudeHome, hookCommand });
    agentsConfigured.push("claude");
    agentLines.push(
      install.hookAction === "error"
        ? "✗ Claude settings.json is not valid JSON — hook left untouched"
        : "✓ Claude integration",
    );
    if (install.permissionAction === "error") {
      warnings.push(
        "Claude settings.json is not valid JSON, so the narrow ctx command permissions\n" +
          "  were left untouched. Fix the JSON, then run: ctx install claude --repair\n" +
          "  (Until then Claude will ask to approve each ctx memory write.)",
      );
    }
  }

  // Codex + Cursor: only in auto-detect mode, only when present. Both share the
  // repo's static AGENTS.md (written once via a short-lived ctx).
  const syncRepoSafe = (): boolean => {
    try {
      const c = CtxContext.open(env);
      try {
        syncProject(c, cwd);
        return true;
      } finally {
        c.close();
      }
    } catch {
      return false; // not in a repo (or transient) — never fatal
    }
  };

  if (auto && detectedAgents.has("codex")) {
    const codexHookCommand =
      ctxResolvesOnPath || !ctxPath ? "ctx hook codex-prompt" : `${quoteCmd(ctxPath)} hook codex-prompt`;
    try {
      const r = installCodex({ home: opts.codexHome, env, hookCommand: codexHookCommand });
      agentsConfigured.push("codex");
      agentLines.push(
        r.hookAction === "error"
          ? "✗ Codex hooks.json is not valid JSON — hook left untouched"
          : "✓ Codex integration",
      );
      // The sandbox writable root is what lets a sandboxed Codex child persist
      // preferences. If its config.toml couldn't be safely merged, ctx still
      // installed — surface the exact manual fix instead of corrupting the file.
      if (r.writableRootAction === "error") {
        warnings.push(
          `Codex config.toml could not be safely updated — left untouched.\n` +
            `  Add this so sandboxed memory writes can reach ctx:\n` +
            `    [sandbox_workspace_write]\n` +
            `    writable_roots = ["${r.ctxHome.replace(/\\/g, "/")}"]\n` +
            `  in ${r.configFile}`,
        );
      }
      syncRepoSafe();
    } catch {
      warnings.push("Could not configure the Codex adapter (left untouched).");
    }
  }
  if (auto && detectedAgents.has("cursor")) {
    // Cursor gets the global memory-WRITE skill (always installable) + the repo's
    // static AGENTS.md READ projection when inside a repo.
    try {
      installCursorSkill({ home: opts.cursorHome });
      syncRepoSafe();
      agentsConfigured.push("cursor");
      agentLines.push("✓ Cursor integration");
    } catch {
      warnings.push("Could not configure the Cursor adapter (left untouched).");
    }
  }

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

  const claudeHookError = install?.hookAction === "error";
  const ok = !claudeHookError && globalInstall !== "failed" && verified;

  return {
    ok,
    home,
    secretBackend: secret.backend,
    secretSecure: secret.secure,
    skills: install?.installedSkills ?? [],
    instructionsAction: install?.instructionsAction ?? "unchanged",
    hookAction: install?.hookAction ?? "absent",
    hookCommand,
    globalInstall,
    globalBinDir: globalBinDir ?? null,
    globalPackageDir: globalPackageDir ?? null,
    previousInstallLinked,
    installSpec,
    ctxPath,
    ctxResolvesOnPath,
    verified,
    runningVersion,
    previousVersion,
    installedVersion,
    warnings,
    agentsConfigured,
    agentLines,
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
    case "repaired": {
      const prev = result.previousVersion;
      return prev && prev !== v
        ? `✓ repaired linked install and upgraded ctx ${prev} → ${v}`
        : `✓ repaired linked install (ctx ${v})`;
    }
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

  const claudeConfigured = result.agentsConfigured.includes("claude");
  // Lines for configured agents OTHER than Claude (Claude keeps its historical wording).
  const extraAgentLines = result.agentsConfigured
    .map((id, i) => ({ id, line: result.agentLines[i] }))
    .filter((x) => x.id !== "claude" && x.line)
    .map((x) => x.line as string);

  if (result.ok && result.warnings.length === 0) {
    const firstInstall = result.globalInstall === "installed";
    out.push(globalLine(result));
    out.push(firstInstall ? "✓ initialized local context" : "✓ preserved local context");
    if (claudeConfigured) {
      out.push(
        result.globalInstall === "installed"
          ? "✓ installed Claude integration"
          : "✓ refreshed Claude integration",
      );
    }
    for (const l of extraAgentLines) out.push(l);
    out.push("");
    // Universal interfaces are always ready once ctx is installed — any other agent can
    // use one of these with no goatedcontext adapter. Stated plainly, without overclaiming
    // that an unknown agent is auto-connected.
    out.push("Universal interfaces (any agent):");
    out.push("  MCP          ready   (ctx mcp)");
    out.push("  Agent CLI    ready   (ctx agent context --json)");
    out.push("  AGENTS.md    ready   (ctx sync)");
    out.push("");
    // Only tell the user to restart Claude when Claude was actually configured.
    if (claudeConfigured) out.push("Restart Claude Code.");
    if (result.globalInstall === "upgraded" || result.globalInstall === "repaired")
      out.push("goat upgraded.");
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
