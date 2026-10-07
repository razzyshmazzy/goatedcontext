import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openDb, sqliteBackend, type Database } from "../storage/sqlite/driver.ts";
import { runtimeLabel, whichSync } from "../utils/runtime.ts";
import { resolvePaths } from "../storage/paths.ts";
import { ConfigSchema } from "../storage/config.ts";
import { createSecretStore } from "../storage/secrets/index.ts";
import { migrations } from "../storage/sqlite/migrations.ts";
import {
  detectPromptHook,
  getPromptHookCommand,
  HOOK_COMMAND_DEFAULT,
} from "../adapters/claude/hook.ts";
import { CTX_INSTRUCTION_BEGIN } from "../adapters/claude/skills.ts";
import { agentStatuses } from "../core/agents/registry.ts";

const LATEST_MIGRATION = migrations.reduce((m, x) => Math.max(m, x.version), 0);

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  /** Grouping header shown in human output. */
  section: string;
  /** Stable machine-readable id (used by tests and `--json`). */
  id: string;
  /** Short human label. */
  label: string;
  status: CheckStatus;
  /** Extra context appended after the label (safe; never a secret value). */
  detail?: string;
  /** Concrete suggested remedy, shown for warn/fail. */
  fix?: string;
}

export interface DoctorReport {
  version: string;
  /** True when no check failed (warnings are allowed). */
  ok: boolean;
  hasWarnings: boolean;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  /** The ctx CLI version string. */
  version: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Override the Claude config dir (~/.claude). */
  claudeHome?: string;
  /** Resolve an executable on PATH (injectable for tests). */
  which?: (cmd: string, path?: string) => string | null;
  /**
   * Skip the optional Claude adapter checks (skills/instructions/hook/PATH).
   * Intended for CI/headless runs where Claude Code is intentionally absent: the
   * core DB/runtime/config/secret checks still run and can still fail the report,
   * but the missing optional integration does not.
   */
  skipAdapter?: boolean;
}

function defaultWhich(cmd: string, path?: string): string | null {
  try {
    return whichSync(cmd, path);
  } catch {
    return null;
  }
}

/** Does `dir` exist and accept a write? Creates the dir if missing (benign for ctx home). */
function isWritable(dir: string): boolean {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.ctx-doctor-${process.pid}.tmp`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** First shell token of a command, with surrounding quotes stripped. */
function commandExecutable(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return first.replace(/^["']|["']$/g, "");
}

/**
 * Build a structured health report. Never throws: every check is defensive so
 * `ctx doctor` works even when the DB is corrupt or the home is unusable.
 */
export function runDoctor(deps: DoctorDeps): DoctorReport {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const which = deps.which ?? defaultWhich;
  const skipAdapter = deps.skipAdapter ?? false;
  const paths = resolvePaths(env);
  const claudeHome = deps.claudeHome ?? join(homedir(), ".claude");

  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);

  // ---- ctx / runtime -------------------------------------------------------
  add({ section: "ctx", id: "version", label: "version", status: "ok", detail: deps.version });
  add({
    section: "ctx",
    id: "runtime",
    label: "runtime",
    status: "ok",
    detail: `${runtimeLabel()} · sqlite: ${sqliteBackend()}`,
  });

  // ---- paths ---------------------------------------------------------------
  const overridden = Boolean(env.CTX_HOME && env.CTX_HOME.trim().length > 0);
  add({
    section: "Paths",
    id: "ctx-home",
    label: "CTX_HOME",
    status: "ok",
    detail: `${paths.home}${overridden ? " (from CTX_HOME)" : " (default)"}`,
  });
  const configDir = dirname(paths.configFile);
  add({
    section: "Paths",
    id: "config-dir-writable",
    label: "config directory writable",
    status: isWritable(configDir) ? "ok" : "fail",
    detail: configDir,
    fix: `Ensure ${configDir} exists and is writable by your user.`,
  });
  const dbDir = dirname(paths.dbFile);
  add({
    section: "Paths",
    id: "db-dir-writable",
    label: "database directory writable",
    status: isWritable(dbDir) ? "ok" : "fail",
    detail: dbDir,
    fix: `Ensure ${dbDir} exists and is writable by your user.`,
  });

  // ---- config --------------------------------------------------------------
  if (existsSync(paths.configFile)) {
    try {
      ConfigSchema.parse(JSON.parse(readFileSync(paths.configFile, "utf8")));
      add({ section: "Config", id: "config-valid", label: "config.json valid", status: "ok" });
    } catch (err) {
      add({
        section: "Config",
        id: "config-valid",
        label: "config.json valid",
        status: "fail",
        detail: (err as Error).message,
        fix: `Fix or delete ${paths.configFile}; ctx recreates a default on next run.`,
      });
    }
  } else {
    add({
      section: "Config",
      id: "config-valid",
      label: "config.json present",
      status: "warn",
      detail: "not created yet",
      fix: "Run `ctx init`.",
    });
  }

  // ---- database ------------------------------------------------------------
  if (!existsSync(paths.dbFile)) {
    add({
      section: "Database",
      id: "db-readable",
      label: "database exists",
      status: "warn",
      detail: "not created yet",
      fix: "Run `ctx init`.",
    });
  } else {
    let db: Database | null = null;
    try {
      db = openDb(paths.dbFile, { readonly: true });
      add({ section: "Database", id: "db-readable", label: "database readable", status: "ok" });

      // Integrity check.
      try {
        const rows = db.query("PRAGMA integrity_check").all() as Array<Record<string, string>>;
        const first = rows[0] ? Object.values(rows[0])[0] : undefined;
        if (first === "ok") {
          add({ section: "Database", id: "integrity", label: "SQLite integrity", status: "ok" });
        } else {
          add({
            section: "Database",
            id: "integrity",
            label: "SQLite integrity",
            status: "fail",
            detail: String(first ?? "unknown failure"),
            fix: "The database is corrupt. Restore a backup or re-create ~/.ctx (this loses local data).",
          });
        }
      } catch (err) {
        add({
          section: "Database",
          id: "integrity",
          label: "SQLite integrity",
          status: "fail",
          detail: (err as Error).message,
          fix: "The database is unreadable. Restore a backup or re-create ~/.ctx (this loses local data).",
        });
      }

      // Schema / migrations current.
      try {
        const row = db
          .query<{ v: number | null }, []>("SELECT MAX(version) AS v FROM schema_migrations")
          .get();
        const at = row?.v ?? 0;
        if (at >= LATEST_MIGRATION) {
          add({
            section: "Database",
            id: "schema",
            label: "schema up to date",
            status: "ok",
            detail: `v${at}`,
          });
        } else {
          add({
            section: "Database",
            id: "schema",
            label: "schema up to date",
            status: "warn",
            detail: `at v${at}, latest v${LATEST_MIGRATION}`,
            fix: "Run any `ctx` command to apply pending migrations.",
          });
        }
      } catch (err) {
        add({
          section: "Database",
          id: "schema",
          label: "schema up to date",
          status: "fail",
          detail: (err as Error).message,
          fix: "Schema table missing. Run `ctx init`, or re-create ~/.ctx if the file is not a ctx database.",
        });
      }

      // WAL journal mode (persisted on-disk; the multiprocess-concurrency guarantee).
      // busy_timeout is a per-connection runtime pragma, not on-disk, so it is pinned by
      // the live wal-audit test rather than this read-only inspection.
      try {
        const jm = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
        const wal = jm?.journal_mode?.toLowerCase() === "wal";
        add({
          section: "Database",
          id: "wal",
          label: "WAL journal mode",
          status: wal ? "ok" : "warn",
          detail: jm?.journal_mode ?? "unknown",
          fix: wal ? undefined : "Run any `ctx` command to (re)enable WAL.",
        });
      } catch {
        /* non-fatal: integrity/readable checks already cover a broken DB */
      }
    } catch (err) {
      add({
        section: "Database",
        id: "db-readable",
        label: "database readable",
        status: "fail",
        detail: (err as Error).message,
        fix: "The database file is unreadable or not a valid SQLite database.",
      });
    } finally {
      db?.close();
    }
  }

  // ---- git -----------------------------------------------------------------
  let gitOk = false;
  try {
    const out = execFileSync("git", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    gitOk = true;
    add({ section: "Git", id: "git-exe", label: "git executable", status: "ok", detail: out });
  } catch {
    add({
      section: "Git",
      id: "git-exe",
      label: "git executable",
      status: "fail",
      detail: "not found on PATH",
      fix: "Install Git and ensure it is on PATH; repo scoping needs it.",
    });
  }

  if (gitOk) {
    let root: string | null = null;
    try {
      root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      root = null;
    }
    add({
      section: "Git",
      id: "repo-detected",
      label: "current repository",
      status: "ok",
      detail: root ? root : "(not inside a git repository)",
    });
  }

  // ---- secrets -------------------------------------------------------------
  try {
    const secrets = createSecretStore(paths, env);
    const info = secrets.describe();
    add({
      section: "Secrets",
      id: "secret-backend",
      label: "secret backend",
      status: info.secure ? "ok" : "warn",
      detail: info.secure ? info.backend : `${info.backend} (fallback — key stored on disk)`,
      fix: info.secure
        ? undefined
        : "No OS keychain in use. On Windows set CTX_SECRET_BACKEND=dpapi; otherwise protect ~/.ctx/secrets.",
    });
  } catch (err) {
    add({
      section: "Secrets",
      id: "secret-backend",
      label: "secret backend",
      status: "fail",
      detail: (err as Error).message,
      fix: "Check CTX_SECRET_BACKEND; use `auto` or `file` if a native backend is unavailable.",
    });
  }

  // ---- Claude adapter ------------------------------------------------------
  // Optional integration. `--skip-adapter` omits this whole section so a headless
  // /CI run is not failed by the (expected) absence of Claude Code, while every
  // core DB/runtime/config/secret check above still runs and can still fail.
  if (!skipAdapter) {
    add({
      section: "Claude",
      id: "claude-home",
      label: "config location",
      status: existsSync(claudeHome) ? "ok" : "warn",
      detail: claudeHome,
      fix: existsSync(claudeHome) ? undefined : "Run `ctx install claude` after installing Claude Code.",
    });

    const skillFile = join(claudeHome, "skills", "context", "SKILL.md");
    add({
      section: "Claude",
      id: "skills",
      label: "skills installed",
      status: existsSync(skillFile) ? "ok" : "fail",
      fix: existsSync(skillFile) ? undefined : "Run `ctx install claude`.",
    });

    const instructionsFile = join(claudeHome, "CLAUDE.md");
    let instructionsOk = false;
    try {
      instructionsOk =
        existsSync(instructionsFile) &&
        readFileSync(instructionsFile, "utf8").includes(CTX_INSTRUCTION_BEGIN);
    } catch {
      instructionsOk = false;
    }
    add({
      section: "Claude",
      id: "instructions",
      label: "global instructions installed",
      status: instructionsOk ? "ok" : "fail",
      fix: instructionsOk ? undefined : "Run `ctx install claude`.",
    });

    const settingsFile = join(claudeHome, "settings.json");
    let hookInstalled = false;
    try {
      hookInstalled = detectPromptHook(settingsFile);
    } catch {
      hookInstalled = false;
    }
    add({
      section: "Claude",
      id: "hook",
      label: "proactive retrieval hook installed",
      status: hookInstalled ? "ok" : "fail",
      fix: hookInstalled ? undefined : "Run `ctx install claude`.",
    });

    // Hook command must resolve on PATH, or Claude cannot run it.
    const hookCommand =
      (hookInstalled ? getPromptHookCommand(settingsFile) : null) ?? HOOK_COMMAND_DEFAULT;
    const exe = commandExecutable(hookCommand);
    let resolved: string | null = null;
    if (exe.includes("/") || exe.includes("\\")) {
      resolved = existsSync(exe) ? exe : null;
    } else {
      resolved = which(exe, env.PATH);
    }
    add({
      section: "Claude",
      id: "hook-on-path",
      label: `hook command resolves on PATH (${exe})`,
      status: resolved ? "ok" : "fail",
      detail: resolved ?? "not found",
      fix: resolved
        ? undefined
        : "Run `npx goatedcontext setup`, or add the npm global bin directory to PATH.",
    });

    // Codex + Cursor adapters, diagnosed INDEPENDENTLY (one broken adapter never
    // suppresses the others). Absent agents are normal, so these never `fail` — a
    // detected-but-unconfigured agent is a `warn` with an actionable fix.
    const statuses = agentStatuses({ env, cwd: deps.cwd, claudeHome: deps.claudeHome });
    const repairHint = (id: string) => (id === "claude" ? "ctx install claude --repair" : `ctx repair ${id}`);
    for (const s of statuses) {
      if (s.id !== "claude") {
        // Overall integration (Claude's is covered by the detailed checks above).
        let status: CheckStatus;
        let detail: string;
        let fix: string | undefined;
        if (s.healthy) {
          status = "ok";
          detail = "configured";
        } else if (s.detected) {
          status = "warn";
          detail = "installed but not fully configured for ctx";
          fix = `Run \`ctx install ${s.id}\`.`;
        } else {
          status = "ok";
          detail = "not installed (optional)";
        }
        add({ section: s.label, id: `${s.id}-adapter`, label: "ctx integration", status, detail, fix });
      }
      // Memory-WRITE skill/guidance, verified per DETECTED agent (incl. Claude).
      if (s.detected) {
        const mh = s.memorySkill.health;
        add({
          section: s.label,
          id: `${s.id}-memory-skill`,
          label: "ctx memory skill",
          status: mh === "current" ? "ok" : "warn",
          detail: mh === "current" ? "installed" : mh === "stale" ? "stale" : "missing",
          fix: mh === "current" ? undefined : `Run \`${repairHint(s.id)}\`.`,
        });
      }

      // Codex sandbox writable root: the ctx DB lives outside the repo, so a sandboxed
      // Codex child can only persist preferences if the effective ctx home is listed
      // as a writable root. We report on config PRESENCE — we can't prove the kernel
      // honored it without a real sandboxed write — so the wording stays honest.
      if (s.id === "codex" && s.detected && s.writableRootConfigured !== null) {
        add({
          section: s.label,
          id: "codex-writable-root",
          label: "ctx writable root",
          status: s.writableRootConfigured ? "ok" : "warn",
          detail: s.writableRootConfigured ? paths.home : `${paths.home} not in writable_roots`,
          fix: s.writableRootConfigured ? undefined : "Run `ctx repair codex`.",
        });
      }

      // Narrow ctx command permissions (seamless memory writes, no per-call prompt).
      // Reported per detected agent where ctx can safely install a rule (Claude/Codex).
      // An org-managed policy can still override a local allow — we report PRESENCE of
      // our rule, not that the host will honor it over a managed deny.
      if (s.detected && s.installed && s.permissionsConfigured !== null) {
        add({
          section: s.label,
          id: `${s.id}-permissions`,
          label: "ctx command permissions",
          status: s.permissionsConfigured ? "ok" : "warn",
          detail: s.permissionsConfigured
            ? "narrow ctx allow rules installed"
            : "narrow ctx allow rules missing (memory writes will prompt)",
          fix: s.permissionsConfigured ? undefined : `Run \`${repairHint(s.id)}\`.`,
        });
      }
    }

    // Windows ctx command: agents must invoke `ctx.cmd` (not the `ctx.ps1` shim that
    // PowerShell blocks). Verify the runnable launcher resolves on PATH.
    if (process.platform === "win32") {
      const cmd = "ctx.cmd";
      const resolvedCmd = which(cmd, env.PATH);
      add({
        section: "Codex",
        id: "windows-ctx-command",
        label: `Windows ctx command (${cmd})`,
        status: resolvedCmd ? "ok" : "warn",
        detail: resolvedCmd ?? "not found on PATH",
        fix: resolvedCmd ? undefined : "Run `npx goatedcontext setup`, or add the npm global bin directory to PATH.",
      });
    }
  }

  // ---- universal interfaces (0.4.0) ---------------------------------------
  // Always validated (not gated by skipAdapter): these are the agent-neutral transports
  // any agent can use. The Agent CLI is the running binary; MCP launchability is proven
  // by the persistent `ctx` launcher resolving on PATH (so `ctx mcp` is spawnable).
  add({
    section: "Universal",
    id: "agent-cli",
    label: "Agent CLI",
    status: "ok",
    detail: "ctx agent context --json",
  });
  const launcher = process.platform === "win32" ? "ctx.cmd" : "ctx";
  const resolvedLauncher = which(launcher, env.PATH);
  add({
    section: "Universal",
    id: "mcp-launchable",
    label: "MCP server launchable",
    status: resolvedLauncher ? "ok" : "warn",
    detail: resolvedLauncher ? `${launcher} mcp` : `${launcher} not found on PATH`,
    fix: resolvedLauncher ? undefined : "Run `npx goatedcontext setup` to install the persistent ctx launcher.",
  });

  const ok = !checks.some((c) => c.status === "fail");
  const hasWarnings = checks.some((c) => c.status === "warn");
  return { version: deps.version, ok, hasWarnings, checks };
}

const SYMBOL: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

/** Render a report as concise, grouped, human-readable lines. */
export function renderDoctor(report: DoctorReport): string[] {
  const out: string[] = [];
  out.push(`ctx doctor — ${report.version}`);
  let section = "";
  for (const c of report.checks) {
    if (c.section !== section) {
      section = c.section;
      out.push("");
      out.push(`${section}:`);
    }
    const detail = c.detail ? ` — ${c.detail}` : "";
    out.push(`  ${SYMBOL[c.status]} ${c.label}${detail}`);
    if (c.fix && c.status !== "ok") out.push(`    Fix: ${c.fix}`);
  }
  out.push("");
  const fails = report.checks.filter((c) => c.status === "fail").length;
  const warns = report.checks.filter((c) => c.status === "warn").length;
  if (fails === 0 && warns === 0) out.push("All checks passed. ctx is healthy.");
  else out.push(`${fails} problem(s), ${warns} warning(s).`);
  return out;
}
