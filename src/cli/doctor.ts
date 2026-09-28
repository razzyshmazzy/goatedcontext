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
import { Database } from "bun:sqlite";
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
}

function defaultWhich(cmd: string, path?: string): string | null {
  try {
    return Bun.which(cmd, path ? { PATH: path } : undefined) ?? null;
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
  const paths = resolvePaths(env);
  const claudeHome = deps.claudeHome ?? join(homedir(), ".claude");

  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);

  // ---- ctx / runtime -------------------------------------------------------
  add({ section: "ctx", id: "version", label: "version", status: "ok", detail: deps.version });
  add({
    section: "ctx",
    id: "runtime",
    label: "Bun runtime",
    status: "ok",
    detail: typeof Bun !== "undefined" ? `Bun ${Bun.version}` : "unknown",
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
      db = new Database(paths.dbFile, { readonly: true });
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
      : "Run `bun link` in the goatedcontext repo, or add ~/.bun/bin to PATH.",
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
