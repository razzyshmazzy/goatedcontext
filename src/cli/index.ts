import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { ZodError, z } from "zod";
import { CtxContext } from "../core/context.ts";
import { buildContextEnvelope } from "../core/agents/envelope.ts";
import { renderContextBlock } from "../core/render/context-block.ts";
import { classifyDomain, isCanonicalDomain, CANONICAL_DOMAINS, DOMAIN_ALIASES } from "../core/signals/domains.ts";
import { CtxError, ValidationError } from "../utils/errors.ts";
import { shortId } from "../utils/id.ts";
import { installClaude, repairClaude, uninstallClaude } from "../adapters/claude/installer.ts";
import { installCodex, uninstallCodex } from "../adapters/codex/installer.ts";
import {
  installCursorSkill,
  uninstallCursorSkill,
  installCursorRuntime,
  uninstallCursorRuntime,
} from "../adapters/cursor/installer.ts";
import { syncProject, unsyncProject } from "../core/project/sync.ts";
import { planDelivery } from "../core/agents/delivery.ts";
import { capabilitiesFor, type AgentId } from "../core/agents/capabilities.ts";
import { agentStatuses } from "../core/agents/registry.ts";
import { universalInterfaces } from "../core/agents/universal.ts";
import { CTX_INSTRUCTION_BEGIN } from "../adapters/claude/skills.ts";
import { detectPromptHook, formatHookContext } from "../adapters/claude/hook.ts";
import { simulateAgent } from "../adapters/test-hook.ts";
import { findConflicts } from "../core/preferences/conflicts.ts";
import { exportData, importData } from "../core/transfer/transfer.ts";
import { writeFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { line, printJson, warn } from "./output.ts";
import { runDoctor, renderDoctor } from "./doctor.ts";
import { runSetup, renderSetup } from "./setup.ts";
import { readStdin, readStdinLine, runChildInherit } from "../utils/runtime.ts";
import { timeAgo } from "../utils/time.ts";
import { toJson as statsToJson } from "../core/stats/stats.ts";
import { VERSION } from "../version.ts";
import type { Applicability, Scope } from "../core/preferences/types.ts";
import {
  type Condition,
  type RepoResolver,
  buildWhenCondition,
  canonicalizeCondition,
  compactCondition,
  parseCondition,
  renderConditionLines,
  resolveRepoLeaves,
} from "../core/preferences/conditions.ts";
import { detectRepoIdentity } from "../core/repos/repo.ts";
import { createGitProbe } from "../utils/git.ts";
import type { EnvScope, RiskLevel } from "../core/environments/service.ts";

/** Args after a `--`/`--exec` separator, captured by the entry point for `env run`. */
export interface CliDeps {
  passthrough: string[] | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * Hook-specific DB lock-wait bound (ms). The prompt hook is latency-sensitive and must
 * FAIL OPEN rather than block the agent: if the DB is locked, it waits only this long
 * (well under the agent's hook deadline, and far above a normal uncontended read of a
 * few ms) before giving up with no context. Normal CLI writes keep the durable 10s wait.
 */
const HOOK_BUSY_TIMEOUT_MS = 250;

function withContext<T>(
  deps: CliDeps,
  fn: (ctx: CtxContext) => T,
  opts: { busyTimeoutMs?: number } = {},
): T {
  const ctx = CtxContext.open(deps.env ?? process.env, opts);
  try {
    return fn(ctx);
  } finally {
    ctx.close();
  }
}

/**
 * Replace any occurrence of a known secret value in `text` with `[redacted]`. Used to
 * scrub subprocess error messages (Node's spawn validation echoes the offending value)
 * before they can reach stderr. Longest values first so a value that is a substring of
 * another is not partially left behind.
 */
function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of [...secrets].filter((v) => v.length > 0).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join("[redacted]");
  }
  return out;
}

/**
 * A STRICT integer option coercion for Commander. `parseInt` accepts a numeric prefix
 * ("1e3" → 1, "10foo" → 10), silently corrupting the argument. This consumes the WHOLE
 * string: only an optional sign + digits is accepted. Rejects "1e3", "1.5", "10foo",
 * "NaN", "Infinity", "" and out-of-range values with an actionable error (thrown during
 * parse → surfaced cleanly by runCli). Use for every integer flag (limit, budgets, …).
 */
function strictIntOption(flag: string, opts: { min?: number; max?: number } = {}) {
  return (raw: string): number => {
    const s = raw.trim();
    if (!/^[+-]?\d+$/.test(s)) {
      throw new ValidationError(`Invalid value for ${flag}: "${raw}" is not a whole number.`);
    }
    const n = Number(s);
    if (!Number.isSafeInteger(n)) {
      throw new ValidationError(`Invalid value for ${flag}: "${raw}" is out of range.`);
    }
    if (opts.min != null && n < opts.min) {
      throw new ValidationError(`Invalid value for ${flag}: must be at least ${opts.min}.`);
    }
    if (opts.max != null && n > opts.max) {
      throw new ValidationError(`Invalid value for ${flag}: must be at most ${opts.max}.`);
    }
    return n;
  };
}

function resolveRepoOrThrow(ctx: CtxContext, cwd: string) {
  const repo = ctx.repos.resolve(cwd);
  if (!repo) {
    throw new CtxError(
      "Not inside a git repository. Repo scope requires a git repo (use --scope global otherwise).",
    );
  }
  return repo;
}

function provenance(opts: { agentId?: string; sessionId?: string }) {
  return { agentId: opts.agentId, sessionId: opts.sessionId };
}

/**
 * Resolve the memory-write SOURCE class (0.3.7). A bare, human-typed CLI invocation
 * (no `--agent-id`) is treated as a direct user action, so `--origin` is optional and
 * defaults to user. An AGENT-integrated write (`--agent-id` present) MUST pass
 * `--origin` explicitly — ctx will not assume developer intent on the agent's behalf,
 * so a forgotten/absent source fails closed. This does not make the model honest
 * (a source-confused agent can still mislabel), but it makes the trusted path explicit.
 */
function resolveOrigin(opts: { origin?: string; agentId?: string }, action: string): string | undefined {
  if (opts.origin) return opts.origin;
  if (opts.agentId) {
    throw new CtxError(
      `${action} with --agent-id must also pass --origin <user|project|external>. ` +
        `ctx cannot assume developer intent on an agent's behalf: use --origin user ONLY for the ` +
        `developer's own request; repository, tool, or web content must never become ctx memory.`,
    );
  }
  return undefined; // human CLI → direct user action (core defaults to `user`)
}

/** Origin classes a caller may pass on the CLI. */
const CLI_ORIGINS = ["user", "project", "external"] as const;

/**
 * Strict schema for `ctx agent context --stdin` (spec §3). Agents that do not want to
 * shell-escape arbitrary user prompts pass a single newline-terminated JSON object on
 * stdin instead. `.strict()` rejects unknown keys so a malformed/oversized payload is a
 * hard validation error (nonzero exit, message to stderr) — never silently accepted,
 * never eval'd.
 */
const StdinContextSchema = z
  .object({
    task: z.string().optional(),
    cwd: z.string().optional(),
    files: z.array(z.string()).optional(),
    languages: z.array(z.string()).optional(),
    domain: z.string().nullable().optional(),
    includeProposed: z.boolean().optional(),
  })
  .strict();

/**
 * AGENT write path (`ctx agent remember|propose|signal add`): `--origin` is MANDATORY
 * and validated — it never defaults to user. This is the security boundary: the agent
 * surface is the only memory-write path that is silently auto-approved by the installed
 * permission rules, so it must never be able to omit provenance and fall back to human
 * intent. A missing or invalid origin is a hard failure (no preference/signal/event).
 */
function requireAgentOrigin(opts: { origin?: string }, label: string): string {
  if (!opts.origin) {
    throw new CtxError(
      `${label} requires --origin <user|project|external>. The agent write path never assumes ` +
        `developer intent: use --origin user ONLY for the developer's own request; repository, ` +
        `tool, or web content must never become ctx memory.`,
    );
  }
  if (!(CLI_ORIGINS as readonly string[]).includes(opts.origin)) {
    throw new CtxError(`${label}: invalid --origin "${opts.origin}". Use one of: ${CLI_ORIGINS.join(", ")}.`);
  }
  return opts.origin;
}

/** Apply the shared `remember` options to a command (human and agent paths are identical). */
function applyRememberOptions(cmd: Command): Command {
  return cmd
    .argument("<rule>", "The preference rule text")
    .option("--scope <scope>", "global | repo", "global")
    .option("--category <category>", "Preference category", "general")
    .option("--domain <domain>", "Explicit decision domain (optional)")
    .option("--repo", "Shortcut for --scope repo")
    .option("--lock", "Create it as a locked preference (cannot be auto-changed)")
    .option("--applicability <value>", "always | relevant | conditional (default: inferred from the rule)")
    .option("--always", "Shortcut for --applicability always (inject on every prompt)")
    .option(
      "--when <key=value>",
      "Conditional rule: inject only when the condition matches (language=, file=, domain=, repo=). Repeatable (AND).",
      collect,
      [],
    )
    .option("--when-json <json>", "Advanced: a structured condition as JSON (all/any/not)")
    .option("--evidence <text>", "Optional supporting evidence")
    .option("--decision-domain <domain>", "Also record a decision signal in this domain (e.g. backend)")
    .option("--decision-choice <choice>", "The chosen option for the decision signal (e.g. supabase)")
    .option("--decision-preferred-choice <choice>", "Exception: the usually-preferred choice this departed from")
    .option("--decision-reason <text>", "Exception: why the choice differed (verbatim; never secrets)")
    .option("--decision-constraint <tag>", "Exception: constraint category (e.g. free-tier)")
    .option("--decision-exception", "Mark the decision signal as an exception to the usual preference")
    .option("--origin <class>", "Source of the intent: user | project | external")
    .option("--agent-id <id>", "Provenance: which agent recorded this")
    .option("--session-id <id>", "Provenance: session identifier")
    .option("--cwd <dir>", "Working directory used to resolve the repo", process.cwd())
    .option("--json", "Output JSON");
}

/** Apply the shared `propose` options to a command. */
function applyProposeOptions(cmd: Command): Command {
  return cmd
    .argument("<rule>", "The proposed rule text")
    .requiredOption("--evidence <text>", "What was observed that implies this rule")
    .option("--scope <scope>", "global | repo", "global")
    .option("--category <category>", "Preference category", "general")
    .option("--domain <domain>", "Explicit decision domain (optional)")
    .option("--repo", "Shortcut for --scope repo")
    .option("--applicability <value>", "always | relevant | conditional (default: inferred from the rule)")
    .option("--always", "Shortcut for --applicability always (inject on every prompt)")
    .option(
      "--when <key=value>",
      "Conditional rule: inject only when the condition matches (language=, file=, domain=, repo=). Repeatable (AND).",
      collect,
      [],
    )
    .option("--when-json <json>", "Advanced: a structured condition as JSON (all/any/not)")
    .option("--source <source>", "Free-text label for the observation", "agent")
    .option("--origin <class>", "Source of the evidence: user | project | external")
    .option("--agent-id <id>", "Provenance: which agent proposed this")
    .option("--session-id <id>", "Provenance: session identifier")
    .option("--cwd <dir>", "Working directory used to resolve the repo", process.cwd())
    .option("--json", "Output JSON");
}

/** Apply the shared `signal add` options to a command. */
function applySignalAddOptions(cmd: Command): Command {
  return cmd
    .requiredOption("--domain <domain>", "Decision domain (e.g. backend, package-manager, frontend-framework)")
    .requiredOption("--choice <choice>", "The chosen option (e.g. supabase, bun, react)")
    .option("--repo", "Link to the repo at --cwd (default: link when --cwd is a git repo)")
    .option("--no-repo", "Record as a repo-less (cross-project) observation")
    .option("--cwd <dir>", "Working directory used to resolve the repo", process.cwd())
    .option("--context <text>", "Optional short provenance note (capped; never secrets)")
    .option("--preferred-choice <choice>", "The usually-preferred choice this decision departed from")
    .option("--reason <text>", "Why the choice differed (compact; preserved verbatim; never secrets)")
    .option("--constraint <tag>", "Constraint category that drove it (e.g. free-tier, existing-stack)")
    .option("--exception", "Mark this as an exception to the usual preference")
    .option("--origin <class>", "Source of the decision: user | project | external")
    .option("--agent-id <id>", "Provenance: which agent recorded this")
    .option("--session-id <id>", "Provenance: session identifier")
    .option("--json", "Output JSON");
}

/**
 * Resolve the applicability from `--always` / `--applicability <v>`.
 * `--always` is a convenience alias for `--applicability always`. Returns
 * `undefined` when neither is given (the service then infers it from the rule).
 * The value itself (e.g. rejecting `banana`) is validated downstream by the zod
 * input schema, so an invalid value fails before any write.
 */
function resolveApplicability(opts: { always?: boolean; applicability?: string }): string | undefined {
  if (opts.always && opts.applicability && opts.applicability !== "always") {
    throw new CtxError(
      `Conflicting flags: --always implies --applicability always, but --applicability ${opts.applicability} was given.`,
    );
  }
  if (opts.always) return "always";
  return opts.applicability;
}

/** Commander collector for a repeatable string option (e.g. multiple `--when`). */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Resolve a friendly repo value to a canonical identity deterministically. Accepts
 * an already-canonical identity (`remote:…`/`path:…`), the current repo by name, or
 * a uniquely-named known repo. Anything ambiguous or unknown fails — we never store
 * an ambiguous repo condition.
 */
function makeRepoResolver(ctx: CtxContext, cwd: string): RepoResolver {
  return (value: string) => {
    const v = value.trim();
    if (v.length === 0) throw new CtxError("repo condition must not be empty.");
    if (v.startsWith("remote:") || v.startsWith("path:")) return v;

    // One request-local probe so the detect-then-resolve pair below reuses a single
    // repo-root/origin lookup instead of spawning git twice over.
    const probe = createGitProbe();
    const detected = detectRepoIdentity(cwd, probe);
    if (detected && detected.name === v) {
      // Register (or fetch) the current repo so the stored identity matches its row.
      const r = ctx.repos.resolve(cwd, probe);
      return r?.identity ?? detected.identity;
    }

    const known = ctx.repos.list();
    const exactIdentity = known.find((r) => r.identity === v);
    if (exactIdentity) return exactIdentity.identity;

    const byName = known.filter((r) => r.name === v);
    if (byName.length === 1) return byName[0]!.identity;
    if (byName.length > 1) {
      throw new CtxError(
        `Repo "${v}" is ambiguous — ${byName.length} known repositories share that name. Use the full identity (e.g. remote:github.com/owner/${v}).`,
      );
    }
    throw new CtxError(
      `Cannot resolve repo "${v}" to a known repository. Run inside that repo, or pass a full identity like remote:github.com/owner/${v}.`,
    );
  };
}

interface ConditionFlags {
  always?: boolean;
  applicability?: string;
  when?: string[];
  whenJson?: string;
}

/**
 * Resolve the effective applicability and (optional) condition from the write-path
 * flags, enforcing every documented flag conflict BEFORE any write:
 *   - `--when` (repeatable) and `--when-json` imply `conditional`;
 *   - `--always` + `--when` is rejected;
 *   - `--applicability relevant|always` + `--when` is rejected;
 *   - `--applicability conditional` with no `--when`/`--when-json` is rejected.
 * Returns `condition = null` for the non-conditional paths.
 */
function resolveApplicabilityAndCondition(
  opts: ConditionFlags,
  repoResolver: RepoResolver,
): { applicability: string | undefined; condition: Condition | null } {
  const when = opts.when ?? [];
  const hasWhen = when.length > 0 || Boolean(opts.whenJson);

  if (!hasWhen) {
    if (opts.applicability === "conditional") {
      throw new CtxError(
        "--applicability conditional requires at least one --when key=value (or --when-json '<json>').",
      );
    }
    return { applicability: resolveApplicability(opts), condition: null };
  }

  if (opts.always) {
    throw new CtxError(
      "Conflicting flags: --always and --when cannot be combined (a preference is either always-on or conditional).",
    );
  }
  if (opts.applicability && opts.applicability !== "conditional") {
    throw new CtxError(
      `Conflicting flags: --when implies --applicability conditional, but --applicability ${opts.applicability} was given.`,
    );
  }
  if (when.length > 0 && opts.whenJson) {
    throw new CtxError("Use either --when flags or --when-json, not both.");
  }

  let condition: Condition;
  if (opts.whenJson) {
    let raw: unknown;
    try {
      raw = JSON.parse(opts.whenJson);
    } catch {
      throw new CtxError("--when-json must be a valid JSON condition.");
    }
    condition = canonicalizeCondition(resolveRepoLeaves(parseCondition(raw), repoResolver));
  } else {
    condition = buildWhenCondition(when, repoResolver);
  }
  return { applicability: "conditional", condition };
}

export function buildProgram(deps: CliDeps): Command {
  const program = new Command();
  program
    .name("ctx")
    .description("A persistent, local-first developer-context layer for AI coding agents.")
    .version(VERSION);

  // ---- init ---------------------------------------------------------------
  program
    .command("init")
    .description("Initialize the ~/.ctx home, database and config.")
    .option("--json", "Output JSON")
    .action((opts) => {
      withContext(deps, (ctx) => {
        const info = {
          home: ctx.paths.home,
          database: ctx.paths.dbFile,
          config: ctx.paths.configFile,
          secretsBackend: ctx.secrets.backend,
        };
        if (opts.json) return printJson({ initialized: true, ...info });
        line("ctx initialized.");
        line(`  home:     ${info.home}`);
        line(`  database: ${info.database}`);
        line(`  config:   ${info.config}`);
        line(`  secrets:  ${info.secretsBackend}`);
      });
    });

  // ---- setup --------------------------------------------------------------
  program
    .command("setup")
    .description("One command: initialize ctx, make it persistent, and auto-configure whichever supported agents (Claude/Codex/Cursor) are installed.")
    .option("--claude-home <dir>", "Override the Claude config dir (~/.claude)")
    .option("--codex-home <dir>", "Override the Codex config dir ($CODEX_HOME or ~/.codex)")
    .option("--cursor-home <dir>", "Override the Cursor config dir (~/.cursor)")
    .option("--cwd <dir>", "Working directory used to resolve the repo for Codex/Cursor projection", process.cwd())
    .option("--skip-global", "Don't install a persistent global `ctx` (advanced/manual installs)")
    .option("--json", "Output JSON")
    .action((opts) => {
      const result = runSetup({
        env: deps.env ?? process.env,
        version: VERSION,
        claudeHome: opts.claudeHome,
        codexHome: opts.codexHome,
        cursorHome: opts.cursorHome,
        cwd: opts.cwd,
        autoDetectAgents: true,
        skipGlobalInstall: Boolean(opts.skipGlobal),
      });
      if (opts.json) printJson(result);
      else for (const l of renderSetup(result)) line(l);
      if (!result.ok) process.exitCode = 1;
    });

  // ---- status -------------------------------------------------------------
  program
    .command("status")
    .description("Concise health summary of the ctx installation.")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option("--claude-home <dir>", "Override the Claude config dir (~/.claude)")
    .option("--json", "Output JSON")
    .action((opts) => {
      withContext(deps, (ctx) => {
        const repo = ctx.repos.resolve(opts.cwd);
        const all = ctx.preferences.list();
        const globals = all.filter((p) => p.scope === "global");
        const repoPrefs = repo ? all.filter((p) => p.scope === "repo" && p.repoId === repo.id) : [];
        const count = (s: string) => globals.filter((p) => p.status === s).length;
        const pending = globals.filter((p) => p.status === "proposed" || p.status === "observed").length;
        const envs = ctx.environments.listApplicable(repo?.id ?? null);
        const claude = detectClaude(opts.claudeHome);
        const secret = ctx.secrets.describe();
        const stats = ctx.stats.read();

        const summary = {
          version: VERSION,
          repository: repo
            ? { name: repo.name, identity: repo.identity, repoPreferences: repoPrefs.length }
            : null,
          globalProfile: {
            approved: count("approved"),
            locked: count("locked"),
            pending,
            rejected: count("rejected"),
          },
          environments: envs.map((e) => ({ name: e.environment.name, available: e.available })),
          claude,
          usefulInjections: stats.contextInjections,
          storage: {
            walEnabled: true,
            secretBackend: secret.backend,
            secretBackendSecure: secret.secure,
            secretBackendNote: secret.note,
          },
        };

        if (opts.json) return printJson(summary);

        line(`ctx ${VERSION}`);
        line("");
        line("Repository:");
        if (repo) {
          line(`  ${repo.name}`);
          line(`  ${repoPrefs.length} repo preferences`);
        } else {
          line("  (not in a git repository)");
        }
        line("");
        line("Global profile:");
        line(`  ${summary.globalProfile.approved} approved`);
        line(`  ${summary.globalProfile.locked} locked`);
        line(`  ${summary.globalProfile.pending} pending`);
        line("");
        line("Environments:");
        if (envs.length === 0) line("  (none)");
        for (const e of envs) line(`  ${e.environment.name}${e.available ? "" : " (secrets missing)"}`);
        line("");
        line("Claude:");
        line(`  ${claude.skillsInstalled ? "✓" : "✗"} skills installed`);
        line(`  ${claude.instructionsInstalled ? "✓" : "✗"} global instructions installed`);
        line(
          claude.hookInstalled
            ? "  ✓ proactive retrieval hook installed"
            : "  ! proactive retrieval hook missing (run: ctx install claude)",
        );
        line(
          stats.contextInjections > 0
            ? `  ✓ ${stats.contextInjections} useful injection${stats.contextInjections === 1 ? "" : "s"} so far`
            : "  · no useful injections yet",
        );
        line("");
        line("Storage:");
        line("  SQLite WAL enabled");
        line(`  secret backend: ${secret.backend}`);
        if (!secret.secure) line(`  WARNING: ${secret.note}`);
      });
    });

  // ---- doctor -------------------------------------------------------------
  program
    .command("doctor")
    .description("Diagnose the ctx installation and suggest fixes for common problems.")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option("--claude-home <dir>", "Override the Claude config dir (~/.claude)")
    .option(
      "--skip-adapter",
      "Skip the optional Claude adapter checks (CI-safe: still fails on real DB/runtime/config errors)",
    )
    .option("--json", "Output JSON")
    .action((opts) => {
      const report = runDoctor({
        version: VERSION,
        env: deps.env ?? process.env,
        cwd: opts.cwd,
        claudeHome: opts.claudeHome,
        skipAdapter: Boolean(opts.skipAdapter),
      });
      if (opts.json) printJson(report);
      else for (const l of renderDoctor(report)) line(l);
      if (!report.ok) process.exitCode = 1;
    });

  // ---- stats --------------------------------------------------------------
  program
    .command("stats")
    .description("Show local-only effectiveness stats: how often ctx has injected useful context.")
    .option("--json", "Output stable machine-readable JSON (raw ISO timestamp)")
    .option("--reset", "Clear only the stats counters (never touches preferences/environments/history)")
    .action((opts) => {
      withContext(deps, (ctx) => {
        if (opts.reset) {
          const ok = ctx.stats.reset();
          if (opts.json) return printJson({ reset: ok, stats: statsToJson(ctx.stats.read()) });
          if (ok) line("goatedcontext stats reset.");
          else warn("Could not reset stats (the stats store was not writable).");
          if (!ok) process.exitCode = 1;
          return;
        }

        const s = ctx.stats.read();
        if (opts.json) return printJson(statsToJson(s));

        const row = (label: string, value: number) =>
          line(`${(label + ":").padEnd(22)}${String(value).padStart(6)}`);
        line("goatedcontext stats");
        line("");
        row("Hook runs", s.hookRuns);
        row("Useful injections", s.contextInjections);
        row("No relevant context", s.noMatch);
        row("Preferences injected", s.preferencesInjected);
        row("Proposals created", s.proposalsCreated);
        line("");
        line("Last useful injection:");
        line(timeAgo(s.lastInjectionAt));
      });
    });

  // ---- remember (human path) + `ctx agent remember` (agent path) ----------
  // Shared body; the ONLY difference is provenance resolution. Human bare CLI defaults
  // omitted origin to `user`; the agent path requires an explicit --origin and fails
  // closed without it. The agent path is the one auto-allowed by the installed
  // permission rules, so it can never silently assume user intent.
  const registerRemember = (parent: Command, mode: "human" | "agent") => {
    const cmd = parent.command("remember");
    cmd.description(
      mode === "agent"
        ? "Agent memory write: record a preference (requires --origin; fails closed without it)."
        : "Explicitly record a developer preference (approved immediately).",
    );
    applyRememberOptions(cmd);
    cmd.action((rule, opts) => {
      const origin =
        mode === "agent" ? requireAgentOrigin(opts, "ctx agent remember") : resolveOrigin(opts, "ctx remember");
      withContext(deps, (ctx) => {
        const { applicability, condition } = resolveApplicabilityAndCondition(
          opts,
          makeRepoResolver(ctx, opts.cwd),
        );
        const scope: Scope = opts.repo ? "repo" : (opts.scope as Scope);
        let repoId: string | null = null;
        if (scope === "repo") repoId = resolveRepoOrThrow(ctx, opts.cwd).id;

        // A decision signal is recorded only when BOTH domain and choice are given.
        const hasDecision = Boolean(opts.decisionDomain && opts.decisionChoice);
        if ((opts.decisionDomain || opts.decisionChoice) && !hasDecision) {
          throw new CtxError("--decision-domain and --decision-choice must be used together.");
        }
        const decision = hasDecision
          ? {
              domain: opts.decisionDomain as string,
              choice: opts.decisionChoice as string,
              // The decision happened in THIS repo: link to the repo-scope id, else the cwd repo.
              repoId: repoId ?? ctx.repos.resolve(opts.cwd)?.id ?? null,
              preferredChoice: opts.decisionPreferredChoice ?? null,
              reason: opts.decisionReason ?? null,
              constraint: opts.decisionConstraint ?? null,
              exception: Boolean(
                opts.decisionException ||
                  opts.decisionPreferredChoice ||
                  opts.decisionReason ||
                  opts.decisionConstraint,
              ),
              origin,
              ...provenance(opts),
            }
          : null;

        const { preference: pref, signal, signalCreated } = ctx.rememberWithDecision(
          {
            rule,
            category: opts.category,
            domain: opts.domain ?? null,
            scope,
            repoId,
            status: opts.lock ? "locked" : "approved",
            applicability: applicability as Applicability | undefined,
            condition,
            evidence: opts.evidence,
            source: "explicit",
            origin,
            ...provenance(opts),
          },
          decision,
        );
        if (opts.json) return printJson({ preference: pref, signal, signalCreated });
        line(`Remembered [${pref.status}] (${shortId(pref.id)}): ${pref.rule}`);
        const condStr = pref.condition ? ` condition=[${compactCondition(pref.condition)}]` : "";
        line(`  scope=${pref.scope} category=${pref.category} domain=${pref.domain ?? "-"} polarity=${pref.polarity} applicability=${pref.applicability}${condStr}`);
        if (signal) {
          const tag = signal.isException ? " (exception)" : "";
          line(`  decision signal: ${signal.domain}=${signal.choiceRaw}${tag}${signalCreated ? "" : " (already recorded)"}`);
        }
      });
    });
  };
  registerRemember(program, "human");

  // ---- propose (human path) + `ctx agent propose` (agent path) ------------
  const registerPropose = (parent: Command, mode: "human" | "agent") => {
    const cmd = parent.command("propose");
    cmd.description(
      mode === "agent"
        ? "Agent memory write: propose a preference from USER evidence (requires --origin; fails closed)."
        : "Propose a preference inferred by an agent (needs review to take effect).",
    );
    applyProposeOptions(cmd);
    cmd.action((rule, opts) => {
      const origin =
        mode === "agent" ? requireAgentOrigin(opts, "ctx agent propose") : resolveOrigin(opts, "ctx propose");
      withContext(deps, (ctx) => {
        const { applicability, condition } = resolveApplicabilityAndCondition(
          opts,
          makeRepoResolver(ctx, opts.cwd),
        );
        const scope: Scope = opts.repo ? "repo" : (opts.scope as Scope);
        let repoId: string | null = null;
        if (scope === "repo") repoId = resolveRepoOrThrow(ctx, opts.cwd).id;
        const result = ctx.preferences.propose({
          rule,
          category: opts.category,
          domain: opts.domain ?? null,
          scope,
          repoId,
          evidence: opts.evidence,
          applicability: applicability as Applicability | undefined,
          condition,
          source: opts.source,
          origin,
          ...provenance(opts),
        });
        // Count only brand-new proposals (decision A): when an equivalent proposal
        // already exists we merely accumulate evidence, which is not a new proposal.
        if (!result.merged) ctx.stats.recordProposalCreated();
        if (opts.json) return printJson(result);
        const p = result.preference;
        const c = ctx.preferences.evidenceCount(p.id);
        if (result.merged) {
          line(`Merged into existing proposal (${shortId(p.id)}); confidence=${p.confidence.toFixed(2)}, evidence=${c}.`);
        } else {
          line(`Proposed (${shortId(p.id)}): ${p.rule}`);
          const condStr = p.condition ? ` condition=[${compactCondition(p.condition)}]` : "";
          line(`  scope=${p.scope} category=${p.category} domain=${p.domain ?? "-"} polarity=${p.polarity} applicability=${p.applicability}${condStr} confidence=${p.confidence.toFixed(2)}`);
        }
        line("Review with: ctx prefs pending");
      });
    });
  };
  registerPropose(program, "human");

  // ---- agent context: the universal retrieval contract (stable JSON envelope) ---
  // The one machine-oriented retrieval path every non-native agent uses; the MCP
  // get_context tool reuses the SAME envelope builder, so CLI and MCP can never
  // diverge (§15). Read-only (track:false) so frequent calls never contend on the
  // write lock. JSON on stdout only; diagnostics/errors go to stderr via the harness.
  const registerAgentContext = (parent: Command) => {
    parent
      .command("context")
      .description("Universal retrieval: the stable JSON envelope of relevant developer context for a task.")
      .option("--task <text>", "Description of the current task")
      .option("--cwd <dir>", "Working directory", process.cwd())
      .option("--file <path>", "Active file (repeatable); enables file/language conditions.", collect, [])
      .option("--language <lang>", "Active language (repeatable); overrides inference.", collect, [])
      .option("--domain <domain>", "Explicit decision-domain override")
      .option("--include-proposed", "Also include non-authoritative candidate proposals")
      .option("--budget-chars <n>", "Max rendered chars delivered (omission reported, never silent)", strictIntOption("--budget-chars", { min: 1 }))
      .option("--budget-prefs <n>", "Max preferences delivered (omission reported, never silent)", strictIntOption("--budget-prefs", { min: 1 }))
      .option("--format <fmt>", "json | text", "json")
      .option("--json", "Alias for --format json")
      .option("--stdin", "Read one JSON object {task,cwd,files,languages,domain,includeProposed} on stdin")
      .action(async (opts) => {
        // Resolve inputs from CLI flags, or a single strict JSON object on stdin (§3).
        let task: string | undefined = opts.task;
        let cwd: string = opts.cwd;
        let files: string[] = (opts.file as string[]) ?? [];
        let languages: string[] = (opts.language as string[]) ?? [];
        let domain: string | null | undefined = opts.domain ?? undefined;
        let includeProposed = Boolean(opts.includeProposed);

        if (opts.stdin) {
          const raw = await readStdin();
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            throw new ValidationError("--stdin expected a single JSON object; could not parse stdin as JSON.");
          }
          const input = StdinContextSchema.parse(parsed);
          if (input.task !== undefined) task = input.task;
          if (input.cwd !== undefined) cwd = input.cwd;
          if (input.files !== undefined) files = input.files;
          if (input.languages !== undefined) languages = input.languages;
          if (input.domain !== undefined) domain = input.domain;
          if (input.includeProposed !== undefined) includeProposed = input.includeProposed;
        }

        const format = opts.json ? "json" : String(opts.format ?? "json");
        if (format !== "json" && format !== "text") {
          throw new ValidationError(`--format must be "json" or "text" (got "${format}").`);
        }

        const budget =
          opts.budgetChars != null || opts.budgetPrefs != null
            ? {
                maxChars: opts.budgetChars != null ? Number(opts.budgetChars) : null,
                maxPreferences: opts.budgetPrefs != null ? Number(opts.budgetPrefs) : null,
              }
            : undefined;

        withContext(deps, (ctx) => {
          const result = ctx.retrieval.retrieve({
            cwd,
            task,
            files,
            languages,
            domain,
            includeProposed,
            budget,
            track: false, // read-only: frequent agent calls must not contend on the write lock
            explain: true, // populate consideredDomains + diagnostics for the envelope/meta
          });
          if (format === "text") {
            // Text mode renders the canonical AUTHORITATIVE block only (proposals never
            // render as preferences). Empty output = no relevant context.
            const authoritative = result.preferences.filter(
              (p) => p.status === "approved" || p.status === "locked",
            );
            const block = renderContextBlock({ ...result, preferences: authoritative });
            if (block) line(block);
            return;
          }
          printJson(buildContextEnvelope(result, { includeProposed, isCanonicalDomain }));
        });
      });
  };

  // ---- agent: the provenance-required, auto-allowed memory-write surface ---
  // These are the ONLY write commands the installed Claude/Codex permission rules
  // auto-approve. Each requires an explicit --origin and fails closed without it, so a
  // write can never silently inherit human/user authority. The bare `ctx remember` /
  // `ctx propose` / `ctx signal add` above remain the human convenience path and are
  // deliberately NOT auto-allowed.
  const agent = program
    .command("agent")
    .description("Agent-integration memory writes (provenance required; the auto-allowed write path).");
  registerRemember(agent, "agent");
  registerPropose(agent, "agent");
  registerAgentContext(agent);

  // ---- prefs --------------------------------------------------------------
  const prefs = program
    .command("prefs")
    .description("List and review preferences.")
    .option("--json", "Output JSON")
    .action((opts) => {
      withContext(deps, (ctx) => {
        const all = ctx.preferences.list();
        if (opts.json) return printJson(all);
        if (all.length === 0) return line('No preferences yet. Try: ctx remember "..."');
        for (const p of all) {
          const cond = p.condition ? ` [${compactCondition(p.condition)}]` : "";
          line(
            `${shortId(p.id)}  [${p.status}/${p.applicability}]${cond} (${p.scope}/${p.category}/${p.domain ?? "-"}) ${p.polarity} c=${p.confidence.toFixed(2)}  ${p.rule}`,
          );
        }
      });
    });

  prefs
    .command("pending")
    .description("Show proposed preferences awaiting review, with evidence.")
    .option("--json", "Output JSON")
    .action((opts, cmd) => {
      // Honor --json whether it was given before or after `pending`.
      const useJson = Boolean(opts.json || cmd.optsWithGlobals().json);
      withContext(deps, (ctx) => {
        const pending = ctx.preferences.pending();
        const enriched = pending.map((p) => ({
          id: p.id,
          rule: p.rule,
          category: p.category,
          domain: p.domain,
          polarity: p.polarity,
          scope: p.scope,
          applicability: p.applicability,
          condition: p.condition,
          confidence: p.confidence,
          evidenceCount: ctx.preferences.evidenceCount(p.id),
          evidence: ctx.preferences.evidenceFor(p.id).map((e) => ({
            source: e.source,
            text: e.evidenceText,
            agentId: e.agentId,
            at: e.createdAt,
          })),
        }));
        if (useJson) return printJson(enriched);
        if (enriched.length === 0) return line("Nothing pending review.");
        for (const p of enriched) {
          line("");
          line(`${shortId(p.id)}  [proposed/${p.applicability}]  (${p.scope}/${p.category}/${p.domain ?? "-"})  ${p.polarity}  confidence=${p.confidence.toFixed(2)}  evidence=${p.evidenceCount}`);
          line(`  rule: ${p.rule}`);
          if (p.condition) line(`  condition: ${compactCondition(p.condition)}`);
          for (const e of p.evidence) line(`  - (${e.source}${e.agentId ? `/${e.agentId}` : ""}) ${e.text}`);
          line(`  approve: ctx prefs approve ${shortId(p.id)}   reject: ctx prefs reject ${shortId(p.id)}`);
        }
      });
    });

  prefs
    .command("approve")
    .description("Approve a proposed preference so it takes effect.")
    .argument("<id>", "Preference id (or unique prefix)")
    .option("--force", "Apply even if the preference changed since you read it")
    .option("--json", "Output JSON")
    .action((id, opts, cmd) => {
      // `--json` may bind to the parent `prefs` command (which also declares it), so
      // honor it whether it landed on this subcommand or the parent — matching `pending`.
      const useJson = Boolean(opts.json || cmd.optsWithGlobals().json);
      withContext(deps, (ctx) => {
        const pref = ctx.preferences.resolveRef(id);
        const updated = ctx.preferences.approve(pref.id, { expectedVersion: pref.version, force: opts.force });
        if (useJson) return printJson(updated);
        line(`Approved (${shortId(updated.id)}): ${updated.rule}`);
      });
    });

  prefs
    .command("reject")
    .description("Reject a preference (kept for audit, never retrieved).")
    .argument("<id>", "Preference id (or unique prefix)")
    .option("--force", "Apply even if the preference changed since you read it")
    .option("--json", "Output JSON")
    .action((id, opts, cmd) => {
      const useJson = Boolean(opts.json || cmd.optsWithGlobals().json);
      withContext(deps, (ctx) => {
        const pref = ctx.preferences.resolveRef(id);
        const updated = ctx.preferences.reject(pref.id, { expectedVersion: pref.version, force: opts.force });
        if (useJson) return printJson(updated);
        line(`Rejected (${shortId(updated.id)}): ${updated.rule}`);
      });
    });

  // ---- forget -------------------------------------------------------------
  program
    .command("forget")
    .description("Permanently delete a preference and its evidence.")
    .argument("<id>", "Preference id (or unique prefix)")
    .option("--force", "Delete even if the preference changed since you read it")
    .option("--json", "Output JSON")
    .action((id, opts) => {
      withContext(deps, (ctx) => {
        const pref = ctx.preferences.resolveRef(id);
        ctx.preferences.forget(pref.id, { expectedVersion: pref.version, force: opts.force });
        if (opts.json) return printJson({ forgotten: pref.id });
        line(`Forgot (${shortId(pref.id)}): ${pref.rule}`);
      });
    });

  // ---- why ----------------------------------------------------------------
  program
    .command("why")
    .description("Explain a preference: rule, scope, status, confidence, evidence.")
    .argument("<id>", "Preference id (or unique prefix)")
    .option("--json", "Output JSON")
    .action((id, opts) => {
      withContext(deps, (ctx) => {
        const pref = ctx.preferences.resolveRef(id);
        const evidence = ctx.preferences.evidenceFor(pref.id);
        const repo = pref.repoId ? ctx.repos.getById(pref.repoId) : null;
        if (opts.json) return printJson({ preference: pref, repo, evidence });
        line(`Preference ${pref.id}`);
        line(`  rule:       ${pref.rule}`);
        line(`  category:   ${pref.category}`);
        line(`  domain:     ${pref.domain ?? "-"}`);
        line(`  polarity:   ${pref.polarity}`);
        line(`  scope:      ${pref.scope}${repo ? ` (${repo.name})` : ""}`);
        line(`  status:     ${pref.status}`);
        line(`  applicability: ${pref.applicability}`);
        if (pref.condition) {
          line("  condition:");
          for (const l of renderConditionLines(pref.condition, 2)) line(l);
        }
        line(`  confidence: ${pref.confidence.toFixed(2)}`);
        line(`  version:    ${pref.version}`);
        line(`  created:    ${pref.createdAt}`);
        line(`  last used:  ${pref.lastUsedAt ?? "never"}`);
        line(`  evidence (${evidence.length}):`);
        for (const e of evidence) line(`    - (${e.source}${e.agentId ? `/${e.agentId}` : ""}) ${e.evidenceText}`);
        line("");
        line("This preference exists because it was recorded from the evidence above and");
        line("has not been rejected. Repo preferences override global ones during retrieval.");
      });
    });

  // ---- conflicts ----------------------------------------------------------
  program
    .command("conflicts")
    .description("Show active preferences that compete (only one can apply). Never auto-resolved.")
    .option("--repo", "Analyze the current repo's effective set (repo + global)")
    .option("--global", "Analyze global preferences only")
    .option("--cwd <dir>", "Working directory used to resolve the repo", process.cwd())
    .option("--json", "Output JSON")
    .action((opts) => {
      if (opts.repo && opts.global) {
        throw new CtxError("Use only one of --repo or --global.");
      }
      withContext(deps, (ctx) => {
        const repo = ctx.repos.resolve(opts.cwd);
        if (opts.repo && !repo) {
          throw new CtxError("Not inside a git repository. --repo requires a git repo.");
        }

        const actives = ctx.preferences
          .list()
          .filter((p) => p.status === "approved" || p.status === "locked");
        const globals = actives.filter((p) => p.scope === "global");

        // Default follows the current context: in a repo, analyze its effective set
        // (repo + global); otherwise fall back to global-only.
        const scopeMode: "global" | "repo" = opts.global ? "global" : opts.repo || repo ? "repo" : "global";
        const analyzing =
          scopeMode === "global" ? "global" : `global + repo (${repo!.name})`;

        let candidates = globals;
        if (scopeMode === "repo") {
          const repoPrefs = actives.filter((p) => p.scope === "repo" && p.repoId === repo!.id);
          candidates = [...globals, ...repoPrefs];
        }

        const conflicts = findConflicts(candidates);

        if (opts.json) {
          return printJson({ analyzing, count: conflicts.length, conflicts });
        }

        line(`Conflicts — ${analyzing}`);
        line("");
        if (conflicts.length === 0) {
          return line("No conflicts among active preferences.");
        }
        line(`${conflicts.length} conflict(s) found.`);
        conflicts.forEach((c, i) => {
          const heading =
            c.kind === "exclusive-domain"
              ? `exclusive-domain: ${c.domain}`
              : `same-subject${c.domain ? ` (${c.domain})` : ""}: ${c.subject}`;
          line("");
          line(`${i + 1}) ${heading}`);
          line(`   ${c.reason}`);
          if (c.ambiguous) {
            line("   ! ambiguous: members share the highest precedence — retrieval falls back to relevance/order.");
          }
          for (const m of c.members) {
            const mark = m.applies ? "→ applies   " : "  suppressed ";
            line(
              `   ${mark} (${shortId(m.id)}) [${m.scope}/${m.status}] polarity=${m.polarity}  ${m.rule}`,
            );
          }
        });
        line("");
        line("Resolve manually (e.g. `ctx forget <id>`, re-scope, or lock a rule); ctx never auto-resolves.");
      });
    });

  // ---- history ------------------------------------------------------------
  program
    .command("history")
    .description("Show recent local changes to preferences and environments (append-only audit).")
    .option("--repo", "Only events for the current repository")
    .option("--limit <n>", "Max events to show", strictIntOption("--limit", { min: 1 }), 20)
    .option("--cwd <dir>", "Working directory used to resolve the repo", process.cwd())
    .option("--json", "Output JSON")
    .action((opts) => {
      withContext(deps, (ctx) => {
        let repoId: string | null | undefined;
        if (opts.repo) {
          const repo = resolveRepoOrThrow(ctx, opts.cwd);
          repoId = repo.id;
        }
        const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 20;
        const events = ctx.events.list(
          repoId !== undefined ? { repoId, limit } : { limit },
        );

        if (opts.json) return printJson(events);
        if (events.length === 0) return line("No history yet.");

        line(`Recent events (${events.length}):`);
        for (const e of events) {
          const when = e.createdAt.replace("T", " ").replace(/\..*$/, "");
          const repoName = e.repoId ? ctx.repos.getById(e.repoId)?.name : null;
          const scopeLabel = repoName ? `repo:${repoName}` : e.scope ?? "-";
          const ref = e.preferenceId ? ` (${shortId(e.preferenceId)})` : "";
          const prov = [e.agentId ? `agent=${e.agentId}` : "", e.sessionId ? `session=${e.sessionId}` : ""]
            .filter(Boolean)
            .join(" ");
          line(
            `${when}  ${eventLabel(e.type).padEnd(11)} [${scopeLabel}]${ref}  ${e.summary}${prov ? `  (${prov})` : ""}`,
          );
        }
      });
    });

  // ---- get ----------------------------------------------------------------
  program
    .command("get")
    .description("Retrieve relevance-filtered, conflict-resolved context (JSON).")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option("--task <text>", "Description of the current task")
    .option("--limit <n>", "Max preferences to return (1-15)", strictIntOption("--limit", { min: 1 }))
    .option("--include-proposed", "Also include proposed/observed preferences")
    .action((opts) => {
      withContext(deps, (ctx) => {
        printJson(
          ctx.retrieval.retrieve({
            cwd: opts.cwd,
            task: opts.task,
            limit: opts.limit,
            includeProposed: Boolean(opts.includeProposed),
          }),
        );
      });
    });

  // ---- hook (internal: called by an agent's prompt hook) ------------------
  // Shared by Claude Code and OpenAI Codex: both run a UserPromptSubmit-style hook,
  // pass `{cwd, prompt}` JSON on stdin, and inject plain stdout into the model's
  // context. The SAME core retrieval + `renderContextBlock` serve both — the only
  // difference is the accepted event name and a couple of tolerant field aliases.
  program
    .command("hook")
    .description("Internal: proactive-retrieval hook invoked by an agent. Reads hook JSON on stdin.")
    .argument("<event>", "Hook event (claude-prompt | codex-prompt | cursor-session)")
    .option("--debug", "Write diagnostics to <ctx home>/hook.log")
    .action(async (event, opts) => {
      // Fail OPEN: this must never make the agent unusable. Any error → no output,
      // exit 0, so the agent proceeds with the user's original prompt untouched.
      const debug = opts.debug || (deps.env ?? process.env).CTX_HOOK_DEBUG;
      try {
        // Cursor's sessionStart hook: distinct input (workspace_roots, no prompt) and a
        // JSON response `{additional_context}` — handled separately from the plain-stdout
        // Claude/Codex prompt hooks.
        if (event === "cursor-session") {
          await runCursorSessionHook(deps, Boolean(debug));
          return;
        }
        if (event !== "claude-prompt" && event !== "codex-prompt") return;
        const raw = await readStdin();
        if (!raw.trim()) return;
        // Tolerant parse: Codex/Claude both send `cwd`; the user prompt is `prompt`
        // (with a couple of defensive aliases in case a Codex version differs).
        const payload = JSON.parse(raw) as {
          cwd?: string;
          prompt?: string;
          user_prompt?: string;
          message?: string;
        };
        const prompt = (payload.prompt ?? payload.user_prompt ?? payload.message ?? "").toString();
        if (!prompt.trim()) return;
        const cwd = payload.cwd && payload.cwd.trim().length > 0 ? payload.cwd : process.cwd();
        const agent = event === "codex-prompt" ? "codex" : "claude";
        // Hook-specific short DB wait: a locked DB fails open fast (no context) rather
        // than stalling the agent for the default 10s. The outer try/catch turns any
        // such failure into a clean no-op exit.
        withContext(deps, (ctx) => {
          const result = ctx.retrieval.retrieve({ cwd, task: prompt, track: false });
          // Capability-driven static/runtime dedup: whatever the delivery planner
          // routes to STATIC for this agent (repo approved/locked always → AGENTS.md
          // for AGENTS-aware agents like Codex) is excluded from the runtime block,
          // so it reaches the agent exactly once. For Claude the static bucket is
          // empty, so this is a no-op and behavior is unchanged.
          const staticIds = new Set(planDelivery(capabilitiesFor(agent), result.preferences).static);
          const runtimePrefs = result.preferences.filter((p) => !staticIds.has(p.id));
          const block = formatHookContext({ ...result, preferences: runtimePrefs });
          // Emit the injected block BEFORE touching stats, so a stats write can
          // never affect what the agent receives. Stats recording is itself fail-open.
          if (block) process.stdout.write(block + "\n");
          if (block) ctx.stats.recordHookInjection(runtimePrefs.length, agent);
          else ctx.stats.recordHookNoMatch(agent);
          if (debug) hookDebug(deps, `[${event}] injected=${block ? "yes" : "no"} n=${runtimePrefs.length} static=${staticIds.size} cwd=${cwd}`);
        }, { busyTimeoutMs: HOOK_BUSY_TIMEOUT_MS });
      } catch (err) {
        if (debug) hookDebug(deps, `error: ${(err as Error).message}`);
        // swallow — fail open
      }
    });

  // ---- mcp (universal MCP transport over stdio) ---------------------------
  // Serves the small MCP tool surface (get_context + memory writes) backed by the SAME
  // core services as the CLI. The SDK is imported LAZILY so normal `ctx` invocations
  // never load it. No daemon: the process lives only while the host keeps the stream
  // open. `ctx agent mcp` is registered as an alias further below.
  const runMcp = async () => {
    const { runMcpServer } = await import("../mcp/server.ts");
    await runMcpServer(deps.env ?? process.env);
  };
  program
    .command("mcp")
    .description("Run the goatedcontext MCP server over stdio (get_context + memory tools).")
    .action(runMcp);
  agent
    .command("mcp")
    .description("Alias of `ctx mcp`: run the MCP server over stdio.")
    .action(runMcp);

  // ---- test-hook (debug delivery for any agent without launching it) ------
  program
    .command("test-hook")
    .description("Dry-run how an agent would receive context for a task (--agent claude|codex|cursor).")
    .requiredOption("--task <text>", "The task/prompt to simulate")
    .option("--agent <id>", "Agent to simulate: claude | codex | cursor", "claude")
    .option(
      "--file <path>",
      "Simulate an active file (enables file/language conditions). Repeatable.",
      collect,
      [],
    )
    .option("--language <lang>", "Override the inferred language for the simulation")
    .option("--domain <domain>", "Override the inferred domain for the simulation")
    .option("--cwd <dir>", "Working directory used to resolve the repo", process.cwd())
    .option("--json", "Output JSON")
    .action((opts) => {
      const agent = opts.agent as string;
      if (agent !== "claude" && agent !== "codex" && agent !== "cursor") {
        throw new CtxError(`Unknown --agent "${agent}". Supported: claude, codex, cursor.`);
      }
      withContext(deps, (ctx) => {
        const result = simulateAgent(ctx, {
          agent: agent as AgentId,
          cwd: opts.cwd,
          task: opts.task,
          files: opts.file,
          languages: opts.language ? [opts.language] : undefined,
          domain: opts.domain ?? undefined,
        });
        if (opts.json) return printJson(result);

        const rc = result.runtimeContext;
        const reasonById = new Map(result.conditionalEvaluations.map((e) => [e.id, e.reason]));

        line(`Agent: ${result.agent}    Task: ${result.task.trim() ? result.task : "(empty)"}`);
        line("");
        line("Runtime context");
        line(`  repo:      ${rc.repo ? `${rc.repo.name} (${rc.repo.identity})` : "(none / not a git repo)"}`);
        line(`  files:     ${rc.files.length ? rc.files.join(", ") : "(none)"}`);
        line(`  languages: ${rc.languages.length ? rc.languages.join(", ") : "(none)"}`);
        line(`  domain:    ${rc.domain ?? "(none)"}`);
        line("");
        line("Delivery plan (this repo's active preferences)");
        const planLine = (label: string, entries: typeof result.plan.static) => {
          line(`  ${label} (${entries.length}):`);
          if (entries.length === 0) line("    (none)");
          for (const e of entries) line(`    - [${e.scope}][${e.applicability}] ${e.rule}`);
        };
        planLine("static → AGENTS.md", result.plan.static);
        planLine("runtime → hook", result.plan.runtime);
        planLine("unsupported", result.plan.unsupported);
        line("");

        if (!result.runtimeSupported) {
          line(`Runtime injection: UNSUPPORTED for ${result.agent} — static delivery (AGENTS.md) only.`);
          line("No hook result is fabricated. The 'static' set above is what reaches this agent.");
          return;
        }

        line(`Would inject context: ${result.wouldInject ? "yes" : "no"}`);
        line("");
        line(`Runtime-injected preferences (${result.preferences.length}):`);
        if (result.preferences.length === 0) line("  (none)");
        for (const p of result.preferences) {
          const domain = p.domain ? `[${p.domain}]` : "";
          line(`  - [${p.scope}][${p.applicability}]${domain} ${p.rule}`);
          if (p.applicability === "conditional") line(`      matched: ${reasonById.get(p.id) ?? "condition matched"}`);
        }
        const notMatched = result.conditionalEvaluations.filter((e) => !e.matched);
        if (notMatched.length > 0) {
          line("");
          line(`Not matched — conditionals whose condition was false (${notMatched.length}):`);
          for (const e of notMatched) line(`  - [${e.scope}][conditional] ${e.rule}  (failed: ${e.reason})`);
        }
        if (result.overridden.length > 0) {
          line("");
          line(`Suppressed by higher-precedence rules (${result.overridden.length}):`);
          for (const o of result.overridden) {
            line(`  - (${shortId(o.id)}) ${o.rule}  →  superseded by ${shortId(o.supersededBy)}`);
          }
        }
        line("");
        const se = result.signalEvidence;
        const patterns = result.observedPatterns ?? [];
        line("Signal evidence (non-authoritative — observed decisions, never instructions)");
        line(`  considered domains: ${se && se.consideredDomains.length ? se.consideredDomains.join(", ") : "(none)"}`);
        line(`  delivered:          ${patterns.length}`);
        line(`  omitted by budget:  ${se ? se.omittedByBudget : 0}`);
        if (patterns.length === 0) {
          line("  (no signal evidence delivered)");
        } else {
          for (const p of patterns) {
            const pref = p.hasExplicitPreference ? " [explicit preference governs — ordinary signals suppressed]" : "";
            const tag = p.contradictory ? " (no stable default)" : "";
            line(`  - ${p.domain}${tag}${pref}`);
            for (const c of p.choices) {
              line(`      choice: ${c.label} — ${c.distinctRepos} repo(s)${c.seenInCurrentRepo ? " incl. this repo" : ""}, ${c.observations} obs`);
            }
            for (const e of p.exceptions) {
              const why = e.reasons.length ? ` — ${e.reasons.join("; ")}` : "";
              line(`      exception: ${e.label}${e.preferredChoice ? ` (vs ${e.preferredChoice})` : ""} — ${e.distinctRepos} repo(s)${why}`);
            }
          }
        }
        line("");
        if (result.block) {
          line("Native runtime output:");
          line("----------------------------------------");
          line(result.block);
          line("----------------------------------------");
        } else {
          line("Native runtime output: (nothing would be injected)");
        }
      });
    });

  // ---- repo ---------------------------------------------------------------
  const repo = program
    .command("repo")
    .description("Show the detected repository identity.")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option("--json", "Output JSON")
    .action((opts) => {
      withContext(deps, (ctx) => {
        const r = ctx.repos.resolve(opts.cwd);
        if (!r) {
          if (opts.json) return printJson({ repo: null });
          return line("Not inside a git repository.");
        }
        if (opts.json) return printJson(r);
        line(`repo:     ${r.name}`);
        line(`identity: ${r.identity}`);
        line(`root:     ${r.rootPath}`);
        line(`remote:   ${r.remoteUrl ?? "(none)"}`);
      });
    });

  repo
    .command("remember")
    .description("Record a repo-scoped preference for the current repository.")
    .argument("<rule>", "The preference rule text")
    .option("--category <category>", "Preference category", "general")
    .option("--domain <domain>", "Explicit decision domain (optional)")
    .option("--lock", "Create it as a locked preference")
    .option("--applicability <value>", "always | relevant | conditional (default: inferred from the rule)")
    .option("--always", "Shortcut for --applicability always (inject on every prompt)")
    .option(
      "--when <key=value>",
      "Conditional rule: inject only when the condition matches (language=, file=, domain=, repo=). Repeatable (AND).",
      collect,
      [],
    )
    .option("--when-json <json>", "Advanced: a structured condition as JSON (all/any/not)")
    .option("--evidence <text>", "Optional supporting evidence")
    .option("--agent-id <id>", "Provenance: which agent recorded this")
    .option("--session-id <id>", "Provenance: session identifier")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option("--json", "Output JSON")
    .action((rule, opts) => {
      withContext(deps, (ctx) => {
        const r = resolveRepoOrThrow(ctx, opts.cwd);
        const { applicability, condition } = resolveApplicabilityAndCondition(
          opts,
          makeRepoResolver(ctx, opts.cwd),
        );
        const pref = ctx.preferences.remember({
          rule,
          category: opts.category,
          domain: opts.domain ?? null,
          scope: "repo",
          repoId: r.id,
          status: opts.lock ? "locked" : "approved",
          applicability: applicability as Applicability | undefined,
          condition,
          evidence: opts.evidence,
          source: "explicit",
          ...provenance(opts),
        });
        if (opts.json) return printJson(pref);
        line(`Remembered repo preference [${pref.status}] (${shortId(pref.id)}) for ${r.name}: ${pref.rule}`);
      });
    });

  // ---- env ----------------------------------------------------------------
  const env = program.command("env").description("Manage reusable development environments.");

  env
    .command("add")
    .description("Create a new environment (metadata only; no secrets yet).")
    .argument("<name>", "Environment name")
    .option("--scope <scope>", "global | repo", "global")
    .option("--repo", "Shortcut for --scope repo")
    .option("--risk <level>", "test | dev | prod", "test")
    .option("--desc <text>", "Description")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option("--json", "Output JSON")
    .action((name, opts) => {
      withContext(deps, (ctx) => {
        const scope: EnvScope = opts.repo ? "repo" : (opts.scope as EnvScope);
        let repoId: string | null = null;
        if (scope === "repo") repoId = resolveRepoOrThrow(ctx, opts.cwd).id;
        const created = ctx.environments.add({
          name,
          scope,
          repoId,
          riskLevel: opts.risk as RiskLevel,
          description: opts.desc ?? null,
        });
        if (opts.json) return printJson(created);
        line(`Created environment "${created.name}" (${created.scope}, risk=${created.riskLevel}).`);
        line(`Add variables with: ctx env set ${created.name} <VAR>`);
      });
    });

  env
    .command("list")
    .description("List environments and whether their secrets are available.")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option("--json", "Output JSON")
    .action((opts) => {
      withContext(deps, (ctx) => {
        const repo = ctx.repos.resolve(opts.cwd);
        const list = ctx.environments.listApplicable(repo?.id ?? null);
        if (opts.json) {
          return printJson(
            list.map((e) => ({
              name: e.environment.name,
              scope: e.environment.scope,
              riskLevel: e.environment.riskLevel,
              available: e.available,
              variableNames: e.variableNames,
            })),
          );
        }
        if (list.length === 0) return line("No environments. Create one: ctx env add <name>");
        for (const e of list) {
          line(
            `${e.environment.name}  [${e.environment.scope}/${e.environment.riskLevel}]  available=${e.available}  vars=[${e.variableNames.join(", ")}]`,
          );
        }
      });
    });

  env
    .command("set")
    .description("Set an environment variable's secret value (stored encrypted; never printed).")
    .argument("<name>", "Environment name")
    .argument("<var>", "Variable name (e.g. OPENAI_API_KEY)")
    .option("--value <value>", "The secret value (note: may be visible in shell history)")
    .option("--from-env <NAME>", "Read the value from this process env var instead")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .action(async (name, varName, opts) => {
      let value: string | undefined = opts.value;
      if (value == null && opts.fromEnv) {
        value = (deps.env ?? process.env)[opts.fromEnv];
        if (value == null) {
          throw new CtxError(`Env var "${opts.fromEnv}" is not set in the current process.`);
        }
      }
      // No flag given: read the secret from stdin (a pipe, or an interactive line).
      // This keeps the value out of shell history. ctx never echoes it.
      if (value == null) {
        value = await readSecretFromStdin(varName);
      }
      if (value == null || value.length === 0) {
        throw new CtxError(
          "No value provided. Use --value <v>, --from-env <NAME>, or pipe/type the value on stdin.",
        );
      }
      const secret = value;
      withContext(deps, (ctx) => {
        const repo = ctx.repos.resolve(opts.cwd);
        const environment = ctx.environments.requireByName(name, repo?.id ?? null);
        ctx.environments.setVariable(environment.id, varName, secret);
        line(`Set ${varName} for environment "${name}" (value stored securely).`);
      });
    });

  env
    .command("vars")
    .description("List the variable NAMES declared by an environment (never values).")
    .argument("<name>", "Environment name")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option("--json", "Output JSON")
    .action((name, opts) => {
      withContext(deps, (ctx) => {
        const repo = ctx.repos.resolve(opts.cwd);
        const environment = ctx.environments.requireByName(name, repo?.id ?? null);
        const names = ctx.environments.variableNames(environment.id);
        if (opts.json) return printJson(names);
        if (names.length === 0) return line("(no variables)");
        for (const n of names) line(n);
      });
    });

  env
    .command("run")
    .description("Run a command with an environment's secrets injected into the child process.")
    .argument("<names...>", "One or more environment names (composed left-to-right)")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .action(async (names: string[], opts) => {
      const passthrough = deps.passthrough;
      if (!passthrough || passthrough.length === 0) {
        throw new CtxError(
          'Provide a command after the separator, e.g.\n' +
            "  bash:       ctx env run test-api -- npm test\n" +
            "  PowerShell: ctx env run test-api --exec npm test",
        );
      }
      await withContext(deps, async (ctx) => {
        const repo = ctx.repos.resolve(opts.cwd);
        const resolved = names.map((n) => ctx.environments.requireByName(n, repo?.id ?? null));
        // Build a child-specific env object; never mutate this process's env.
        const injected = ctx.environments.resolveVariables(resolved);
        const childEnv = { ...(deps.env ?? process.env), ...injected };

        const [cmd, ...cmdArgs] = passthrough;
        let code: number;
        try {
          code = await runChildInherit(cmd!, cmdArgs, { cwd: opts.cwd, env: childEnv });
        } catch (err) {
          // Defense in depth: a runtime spawn error can embed the offending env value
          // (Node's ERR_INVALID_ARG_VALUE echoes it). Redact every injected secret from
          // the message before it can ever surface on stderr.
          throw new CtxError(redactSecrets((err as Error).message, Object.values(injected)));
        }
        if (code !== 0) process.exitCode = code;
      });
    });

  env
    .command("remove")
    .description("Delete an environment and all of its stored secrets.")
    .argument("<name>", "Environment name")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option("--json", "Output JSON")
    .action((name, opts) => {
      withContext(deps, (ctx) => {
        const repo = ctx.repos.resolve(opts.cwd);
        const environment = ctx.environments.requireByName(name, repo?.id ?? null);
        ctx.environments.remove(environment);
        if (opts.json) return printJson({ removed: name });
        line(`Removed environment "${name}" and its secrets.`);
      });
    });

  // ---- context-budget (token-growth instrumentation; measurement only) ----
  // Reports how much memory a task actually delivers, so accumulated-preference growth
  // is MEASURABLE. Pure instrumentation (spec §30): it never drops or rewrites memory.
  // Authoritative overflow (by relevance or an explicit budget) is surfaced, never silent.
  program
    .command("context-budget")
    .description("Measure the delivered context for a task: counts, rendered chars, approx tokens, overflow.")
    .option("--task <text>", "Description of the current task")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option("--include-proposed", "Also account for non-authoritative candidate proposals")
    .option("--budget-chars <n>", "Simulate a rendered-char budget", strictIntOption("--budget-chars", { min: 1 }))
    .option("--budget-prefs <n>", "Simulate a preference-count budget", strictIntOption("--budget-prefs", { min: 1 }))
    .option("--json", "Output JSON")
    .action((opts) => {
      const includeProposed = Boolean(opts.includeProposed);
      const budget =
        opts.budgetChars != null || opts.budgetPrefs != null
          ? {
              maxChars: opts.budgetChars != null ? Number(opts.budgetChars) : null,
              maxPreferences: opts.budgetPrefs != null ? Number(opts.budgetPrefs) : null,
            }
          : undefined;
      withContext(deps, (ctx) => {
        const result = ctx.retrieval.retrieve({
          cwd: opts.cwd,
          task: opts.task,
          includeProposed,
          budget,
          track: false,
          explain: true,
        });
        const env = buildContextEnvelope(result, { includeProposed, isCanonicalDomain });
        const d = env.meta.diagnostics;
        if (opts.json) return printJson({ domains: env.meta.domains, diagnostics: d });
        const row = (label: string, value: number | string) =>
          line(`${(label + ":").padEnd(22)}${String(value).padStart(8)}`);
        line("goatedcontext context budget");
        line("");
        row("Candidate prefs", d.candidate);
        row("Effective prefs", d.effective);
        row("Delivered prefs", d.delivered);
        row("Authoritative", d.authoritative);
        row("Observed patterns", d.observedPatterns);
        row("Rendered chars", d.renderedChars);
        row("Approx tokens", d.approxTokens);
        row("Omitted (relevance)", d.omittedByRelevance);
        row("Omitted (budget)", d.omittedByBudget);
        line("");
        line(
          d.overflow
            ? "OVERFLOW: some effective preferences were not delivered (see omitted counts) — surfaced, never silently dropped."
            : "No overflow: every effective preference was delivered.",
        );
      });
    });

  // ---- domains (inspection/debug only) ------------------------------------
  // A small read-only window onto the canonical decision-domain vocabulary, the tiny
  // alias layer, and whatever custom domains the store has actually observed. ctx does
  // NOT ask users to manage domains — the agent picks a category at write time and the
  // core normalizes/classifies it. Custom (non-canonical) domains are valid and listed.
  program
    .command("domains")
    .description("Inspect canonical decision domains, aliases, and observed custom domains.")
    .option("--json", "Output JSON")
    .action((opts) => {
      withContext(deps, (ctx) => {
        const observedRaw = new Set<string>();
        for (const s of ctx.signals.list()) observedRaw.add(s.domain);
        for (const p of ctx.preferences.list()) if (p.domain) observedRaw.add(p.domain);
        const obsCanonical = new Set<string>();
        const obsCustom = new Set<string>();
        for (const raw of observedRaw) {
          const c = classifyDomain(raw);
          (c.canonical ? obsCanonical : obsCustom).add(c.domain);
        }
        const canonical = [...CANONICAL_DOMAINS].sort();
        if (opts.json) {
          return printJson({
            canonical,
            aliases: DOMAIN_ALIASES,
            observed: { canonical: [...obsCanonical].sort(), custom: [...obsCustom].sort() },
          });
        }
        line("Canonical decision domains (recommended; recognized for automatic cross-repo surfacing):");
        for (const d of canonical) line(`  ${d}`);
        line("");
        line("Aliases (normalized spelling → canonical):");
        for (const [k, v] of Object.entries(DOMAIN_ALIASES)) line(`  ${k} → ${v}`);
        line("");
        const custom = [...obsCustom].sort();
        line(
          `Observed custom domains (valid and retrievable; surface only when a task names them): ${custom.length ? custom.join(", ") : "(none)"}`,
        );
      });
    });

  // ---- signals (evidence ledger, NOT preferences) -------------------------
  // `signal` mutates the ledger; `signals` reads aggregated evidence. Signals are
  // never authoritative — the agent reasons over them and may `ctx propose`, but a
  // signal never becomes a preference automatically (no count threshold anywhere).
  const signal = program
    .command("signal")
    .description("Record non-authoritative evidence of a developer decision (never a preference).");

  // `signal add` (human path) + `ctx agent signal add` (agent path). The agent path
  // requires --origin and fails closed without it; the human path defaults to user.
  const registerSignalAdd = (parent: Command, mode: "human" | "agent") => {
    const cmd = parent.command("add");
    cmd.description(
      mode === "agent"
        ? "Agent memory write: record a decision signal (requires --origin; fails closed)."
        : "Record one decision signal, e.g. `ctx signal add --domain backend --choice supabase`.",
    );
    applySignalAddOptions(cmd);
    cmd.action((opts) => {
      const origin =
        mode === "agent" ? requireAgentOrigin(opts, "ctx agent signal add") : resolveOrigin(opts, "ctx signal add");
      withContext(deps, (ctx) => {
        // Default: link to the current repo when --cwd is inside one, unless --no-repo.
        let repoId: string | null = null;
        if (opts.repo !== false) repoId = ctx.repos.resolve(opts.cwd)?.id ?? null;
        // A preferred-choice/reason/constraint implies this was an exception.
        const exception = Boolean(opts.exception || opts.preferredChoice || opts.reason || opts.constraint);
        const { signal: s, created } = ctx.signals.add({
          domain: opts.domain,
          choice: opts.choice,
          repoId,
          context: opts.context ?? null,
          preferredChoice: opts.preferredChoice ?? null,
          reason: opts.reason ?? null,
          constraint: opts.constraint ?? null,
          exception,
          origin,
          ...provenance(opts),
        });
        if (opts.json) return printJson({ ...s, created });
        const tag = s.isException
          ? ` (exception${s.preferredChoice ? ` vs ${s.preferredChoice}` : ""}${s.constraintTag ? `, ${s.constraintTag}` : ""})`
          : "";
        line(
          created
            ? `Recorded signal: ${s.domain}=${s.choiceRaw}${s.repoId ? " (this repo)" : ""}${tag}.`
            : `Signal already recorded in this context: ${s.domain}=${s.choiceRaw}${tag}.`,
        );
      });
    });
  };
  registerSignalAdd(signal, "human");
  // Agent surface: `ctx agent signal add ...` (auto-allowed; provenance required).
  const agentSignal = agent
    .command("signal")
    .description("Agent-integration decision-signal writes (provenance required).");
  registerSignalAdd(agentSignal, "agent");

  signal
    .command("forget")
    .description("Delete one recorded signal by id.")
    .argument("<id>", "Signal id")
    .option("--json", "Output JSON")
    .action((id, opts) => {
      withContext(deps, (ctx) => {
        const removed = ctx.signals.forget(id);
        if (opts.json) return printJson({ removed });
        line(removed ? `Removed signal ${shortId(id)}.` : `No signal with id ${shortId(id)}.`);
      });
    });

  signal
    .command("clear")
    .description("Delete all signals, or just one domain's (--domain).")
    .option("--domain <domain>", "Only clear this domain")
    .option("--json", "Output JSON")
    .action((opts) => {
      withContext(deps, (ctx) => {
        const removed = ctx.signals.clear(opts.domain);
        if (opts.json) return printJson({ removed });
        line(`Cleared ${removed} signal(s)${opts.domain ? ` in domain "${opts.domain}"` : ""}.`);
      });
    });

  program
    .command("signals")
    .description("Show aggregated, non-authoritative decision evidence (for the agent to reason over).")
    .option("--domain <domain>", "Only this decision domain")
    .option("--raw", "List raw signal rows instead of aggregated evidence")
    .option("--json", "Output JSON")
    .action((opts) => {
      withContext(deps, (ctx) => {
        if (opts.raw) {
          const rows = ctx.signals.list(opts.domain ? { domain: opts.domain } : {});
          if (opts.json) return printJson(rows);
          if (rows.length === 0) return line("No signals recorded.");
          for (const s of rows) {
            line(`${s.createdAt.replace("T", " ").replace(/\..*$/, "")}  ${s.domain}=${s.choiceRaw}  repo=${s.repoId ? shortId(s.repoId) : "-"}  session=${s.sessionId ?? "-"}  (${shortId(s.id)})`);
          }
          return;
        }
        const evidence = ctx.signals.aggregate(opts.domain);
        if (opts.json) return printJson(evidence);
        if (evidence.length === 0) return line("No signals recorded.");
        const repos = (n: number) => `${n} repo${n === 1 ? "" : "s"}`;
        for (const d of evidence) {
          line(`${d.domain}${d.contradictory ? "  (no single stable default yet)" : ""}:`);
          for (const c of d.choices) {
            line(
              `  ${c.label}: ${c.observations} observation${c.observations === 1 ? "" : "s"}` +
                ` across ${repos(c.distinctRepos)}` +
                (c.distinctSessions ? ` / ${c.distinctSessions} session${c.distinctSessions === 1 ? "" : "s"}` : "") +
                ` (last ${c.lastSeen.slice(0, 10)})`,
            );
          }
          if (d.exceptions.length > 0) {
            line("  exceptions:");
            for (const e of d.exceptions) {
              const pref = e.preferredChoice ? ` instead of ${e.preferredChoice}` : "";
              const why = e.reasons.length ? ` — ${e.reasons.join("; ")}` : "";
              const con = e.constraints.length ? ` [${e.constraints.join(", ")}]` : "";
              line(`    ${e.label}${pref}: ${e.observations} across ${repos(e.distinctRepos)}${con}${why}`);
            }
          }
        }
        line("");
        line("Evidence only — not a preference. Exceptions do NOT weaken the default. Decide whether to `ctx propose` based on the pattern.");
      });
    });

  // ---- export -------------------------------------------------------------
  program
    .command("export")
    .description("Export preferences, evidence and repo links as a portable JSON bundle. Never exports secrets or signals.")
    .option("--out <file>", "Write the bundle to a file instead of stdout")
    .action((opts) => {
      withContext(deps, (ctx) => {
        const bundle = exportData(ctx);
        if (opts.out) {
          writeFileSync(opts.out, JSON.stringify(bundle, null, 2) + "\n", { mode: 0o600 });
          warn(`Exported ${bundle.preferences.length} preference(s) to ${opts.out}.`);
        } else {
          printJson(bundle);
        }
      });
    });

  // ---- import -------------------------------------------------------------
  program
    .command("import")
    .description("Import a preference bundle produced by `ctx export`. Idempotent; never overwrites existing rules.")
    .argument("<file>", "Path to a JSON bundle (or - for stdin)")
    .option("--json", "Output JSON")
    .action(async (file, opts) => {
      const raw = file === "-" ? await readStdin() : readFileSync(file, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new CtxError(`"${file}" is not valid JSON.`);
      }
      withContext(deps, (ctx) => {
        const summary = importData(ctx, parsed);
        if (opts.json) return printJson(summary);
        line(
          `Imported ${summary.imported} new preference(s); ` +
            `${summary.skipped} skipped (duplicates/unlinkable); ` +
            `${summary.reposLinked} repo(s) linked.`,
        );
      });
    });

  // ---- install ------------------------------------------------------------
  program
    .command("install")
    .description("Install an agent adapter. Supported targets: claude | codex | cursor")
    .argument("<target>", "Adapter target (claude | codex | cursor)")
    .option("--claude-home <dir>", "Override the Claude config dir (~/.claude)")
    .option("--codex-home <dir>", "Override the Codex config dir ($CODEX_HOME or ~/.codex)")
    .option("--cursor-home <dir>", "Override the Cursor config dir (~/.cursor)")
    .option("--cwd <dir>", "Working directory used to resolve the repo (codex/cursor projection)", process.cwd())
    .option("--hook-command <cmd>", "Command the agent runs for the prompt hook")
    .option("--disable-hook", "Remove the proactive-retrieval hook (keeps skills & preferences)")
    .option("--no-sync", "codex: skip projecting the current repo's AGENTS.md / .cursor rules")
    .option("--repair", "Rewrite any missing/corrupt ctx files and restore the hook")
    .option("--json", "Output JSON")
    .action((target, opts) => {
      if (target === "codex") return installCodexTarget(deps, opts);
      if (target === "cursor") return installCursorTarget(deps, opts);
      if (target !== "claude") {
        throw new CtxError(`Unknown install target "${target}". Supported: claude, codex, cursor`);
      }
      const hookCommand = opts.hookCommand ?? "ctx hook claude-prompt";
      const hookLabelOf = (a: string) =>
        a === "error"
          ? "NOT configured (existing settings.json is not valid JSON — left untouched)"
          : a;

      if (opts.repair) {
        const result = repairClaude({
          claudeHome: opts.claudeHome,
          hookCommand,
          disableHook: Boolean(opts.disableHook),
        });
        if (opts.json) return printJson(result);
        line("Repaired Claude Code adapter.");
        line(`  skills dir:    ${result.skillsDir}`);
        for (const s of result.skills) line(`  skill:         ${s.dir} (${s.action})`);
        line(`  instructions:  ${result.instructionsFile} (${result.instructionsAction})`);
        line(`  prompt hook:   ${result.settingsFile} (${hookLabelOf(result.hookAction)})`);
        return;
      }

      const result = installClaude({
        claudeHome: opts.claudeHome,
        hookCommand,
        disableHook: Boolean(opts.disableHook),
      });
      if (opts.json) return printJson(result);
      line(opts.disableHook ? "Updated Claude Code adapter (hook disabled)." : "Installed Claude Code adapter.");
      line(`  skills dir:    ${result.skillsDir}`);
      line(`  skills:        ${result.installedSkills.join(", ")}`);
      line(`  instructions:  ${result.instructionsFile} (${result.instructionsAction})`);
      line(`  prompt hook:   ${result.settingsFile} (${hookLabelOf(result.hookAction)})`);
    });

  // ---- uninstall ----------------------------------------------------------
  program
    .command("uninstall")
    .description("Remove a ctx agent adapter. Keeps your preferences & environments. Targets: claude | codex | cursor")
    .argument("<target>", "Adapter target (claude | codex | cursor)")
    .option("--claude-home <dir>", "Override the Claude config dir (~/.claude)")
    .option("--codex-home <dir>", "Override the Codex config dir ($CODEX_HOME or ~/.codex)")
    .option("--cursor-home <dir>", "Override the Cursor config dir (~/.cursor)")
    .option("--cwd <dir>", "Working directory used to resolve the repo (cursor projection)", process.cwd())
    .option("--json", "Output JSON")
    .action((target, opts) => {
      if (target === "codex") return uninstallCodexTarget(deps, opts);
      if (target === "cursor") return uninstallCursorTarget(deps, opts);
      if (target !== "claude") {
        throw new CtxError(`Unknown uninstall target "${target}". Supported: claude, codex, cursor`);
      }
      const result = uninstallClaude({ claudeHome: opts.claudeHome });
      if (opts.json) return printJson(result);
      line("Removed the ctx Claude Code adapter. Your preferences and environments are untouched.");
      line(
        `  skills:        ${result.removedSkills.length ? result.removedSkills.join(", ") : "(none present)"}`,
      );
      line(`  instructions:  ${result.instructionsFile} (${result.instructionsAction})`);
      line(`  prompt hook:   ${result.settingsFile} (${result.hookAction})`);
    });

  // ---- repair (converge an adapter's integration to the desired state) -----
  program
    .command("repair")
    .description("Repair a ctx agent adapter — restore/update its runtime integration and memory skill. Targets: claude | codex | cursor")
    .argument("<target>", "Adapter target (claude | codex | cursor)")
    .option("--claude-home <dir>", "Override the Claude config dir (~/.claude)")
    .option("--codex-home <dir>", "Override the Codex config dir ($CODEX_HOME or ~/.codex)")
    .option("--cursor-home <dir>", "Override the Cursor config dir (~/.cursor)")
    .option("--cwd <dir>", "Working directory used to resolve the repo", process.cwd())
    .option("--json", "Output JSON")
    .action((target, opts) => {
      const withRepair = { ...opts, repair: true };
      if (target === "codex") return installCodexTarget(deps, withRepair);
      if (target === "cursor") return installCursorTarget(deps, withRepair);
      if (target !== "claude") {
        throw new CtxError(`Unknown repair target "${target}". Supported: claude, codex, cursor`);
      }
      const result = repairClaude({ claudeHome: opts.claudeHome });
      if (opts.json) return printJson(result);
      line("Repaired Claude Code adapter.");
      for (const s of result.skills) line(`  skill:         ${s.dir} (${s.action})`);
      line(`  instructions:  ${result.instructionsFile} (${result.instructionsAction})`);
      line(`  prompt hook:   ${result.settingsFile} (${result.hookAction})`);
    });

  // ---- sync (static interoperability projection for the current repo) ------
  program
    .command("sync")
    .description("Project this repo's standing preferences into AGENTS.md (read by Codex, Cursor, and other AGENTS.md-aware agents).")
    .option("--cwd <dir>", "Working directory used to resolve the repo", process.cwd())
    .option("--remove", "Remove the goatedcontext projection from this repo instead")
    .option("--json", "Output JSON")
    .action((opts) => {
      withContext(deps, (ctx) => {
        if (opts.remove) {
          const r = unsyncProject(ctx, opts.cwd);
          if (opts.json) return printJson(r);
          line(`Removed goatedcontext projection from ${r.repo.name}.`);
          line(`  AGENTS.md:   ${r.agentsFile} (${r.agentsAction})`);
          return;
        }
        const r = syncProject(ctx, opts.cwd);
        if (opts.json) return printJson(r);
        line(`Synced ${r.ruleCount} repo preference(s) for ${r.repo.name}.`);
        line(`  AGENTS.md:   ${r.agentsFile} (${r.agentsAction})`);
        line("");
        line("AGENTS.md holds only this repo's approved/locked always-on rules. Codex and Cursor both read it. Commit it to share the context with your team.");
      });
    });

  // ---- agents (native integrations + universal interfaces) ----------------
  program
    .command("agents")
    .description("Show native agent integrations, the universal interfaces, and their status.")
    .option("--cwd <dir>", "Working directory (Cursor/AGENTS.md projection is repo-scoped)", process.cwd())
    .option("--claude-home <dir>", "Override the Claude config dir (~/.claude)")
    .option("--codex-home <dir>", "Override the Codex config dir ($CODEX_HOME or ~/.codex)")
    .option("--cursor-home <dir>", "Override the Cursor config dir (~/.cursor)")
    .option("--json", "Output JSON")
    .action((opts) => {
      const statuses = agentStatuses({
        env: deps.env ?? process.env,
        cwd: opts.cwd,
        claudeHome: opts.claudeHome,
        codexHome: opts.codexHome,
        cursorHome: opts.cursorHome,
      });
      const universal = universalInterfaces();
      if (opts.json) {
        // 0.4.0: distinguish native integrations from universal interfaces. `native`
        // preserves the prior per-agent status shape; `universal` is the new section.
        return printJson({ native: statuses, universal });
      }
      line("Native integrations (zero-config when detected):");
      for (const s of statuses) {
        const parts: string[] = [];
        parts.push(s.installed ? "installed" : s.detected ? "detected" : "not installed");
        if (s.capabilities.runtimePromptInjection) parts.push(s.installed ? "runtime ✓" : "runtime available");
        else if (s.capabilities.sessionInjection) parts.push(s.installed ? "session hook ✓" : "session hook available");
        else parts.push("runtime unavailable");
        if (s.capabilities.mcp) parts.push("MCP");
        if (s.capabilities.staticAgentsMd) parts.push(s.staticPresent ? "AGENTS.md ✓" : "AGENTS.md available");
        // Sandbox writable root (Codex only): shown when the agent is configured.
        if (s.writableRootConfigured !== null && s.installed)
          parts.push(s.writableRootConfigured ? "writable root ✓" : "writable root (missing)");
        // Memory-WRITE skill health.
        parts.push(
          s.memorySkill.health === "current"
            ? "memory skill ✓"
            : s.memorySkill.health === "stale"
              ? "memory skill (stale)"
              : "memory skill (missing)",
        );
        // Narrow ctx command permissions (seamless writes) — shown where applicable.
        if (s.permissionsConfigured !== null && s.installed)
          parts.push(s.permissionsConfigured ? "permissions ✓" : "permissions (missing)");
        line(`  ${s.label.padEnd(13)} ${parts.join("   ")}`);
      }
      line("");
      line("Universal interfaces (any agent — no goatedcontext adapter required):");
      for (const u of [universal.mcp, universal.cli, universal.agentsMd]) {
        line(`  ${u.label.padEnd(13)} ${u.ready ? "ready" : "unavailable"}   ${u.description}`);
      }
      line("");
      line("Missing native agents are normal — any other agent can use the universal interfaces above.");
      line("Configure a native integration with: ctx install <claude|codex|cursor>");
    });

  return program;
}

/**
 * `ctx install codex` (also `--repair`): the RUNTIME channel (a `UserPromptSubmit`
 * hook in `~/.codex/hooks.json`) plus the repo's static AGENTS.md via `ctx sync`
 * (unless `--no-sync`). No global `~/.codex/AGENTS.md` — global rules are runtime.
 */
function installCodexTarget(deps: CliDeps, opts: Record<string, unknown>): void {
  withContext(deps, (ctx) => {
    const result = installCodex({
      home: opts.codexHome as string | undefined,
      env: deps.env ?? process.env,
      hookCommand: opts.hookCommand as string | undefined,
      disableHook: Boolean(opts.disableHook),
    });
    let synced: ReturnType<typeof syncProject> | null = null;
    if (opts.sync !== false) {
      try {
        synced = syncProject(ctx, (opts.cwd as string) ?? process.cwd());
      } catch {
        /* not in a repo — the runtime hook still installed fine */
      }
    }
    if (opts.json) return printJson({ codex: result, repoSync: synced });
    line(opts.repair ? "Repaired Codex adapter." : "Installed Codex adapter.");
    line(`  home:          ${result.home}`);
    line(
      result.hookAction === "error"
        ? "  prompt hook:   NOT configured (existing hooks.json is not valid JSON — left untouched)"
        : `  prompt hook:   ${result.hooksFile} (${result.hookAction})`,
    );
    if (synced) line(`  repo AGENTS:   ${synced.agentsFile} (${synced.agentsAction}, ${synced.ruleCount} rule(s))`);
    line(`  memory skill:  ${result.skillFile} (${result.skillAction})`);
    line(
      result.writableRootAction === "error"
        ? "  writable root: NOT configured (config.toml could not be safely merged — left untouched; add it by hand)"
        : `  writable root: ${result.ctxHome} (${result.writableRootAction})`,
    );
    line("");
    if (result.writableRootAction === "error") {
      line(`Add this to ${result.configFile} so sandboxed memory writes can reach ctx:`);
      line("  [sandbox_workspace_write]");
      line(`  writable_roots = ["${result.ctxHome.replace(/\\/g, "/")}"]`);
      line("");
    }
    line("Codex hooks are a new surface; if the prompt hook doesn't fire, verify hooks.json against your Codex version — repo AGENTS.md still applies statically.");
  });
}

/**
 * `ctx install cursor` (also `--repair`): install the global memory-WRITE skill
 * (`~/.cursor/skills/goatedcontext/`) AND project this repo's static AGENTS.md.
 * Cursor has no runtime injection hook, so these two static files are its channels.
 */
function installCursorTarget(deps: CliDeps, opts: Record<string, unknown>): void {
  withContext(deps, (ctx) => {
    const skill = installCursorSkill({ home: opts.cursorHome as string | undefined });
    const runtime = installCursorRuntime({ home: opts.cursorHome as string | undefined });
    let synced: ReturnType<typeof syncProject> | null = null;
    try {
      synced = syncProject(ctx, (opts.cwd as string) ?? process.cwd());
    } catch {
      /* not in a repo — the global memory skill + runtime still installed fine */
    }
    if (opts.json) return printJson({ cursorSkill: skill, cursorRuntime: runtime, repoSync: synced });
    line(opts.repair ? "Repaired Cursor adapter." : "Installed Cursor adapter.");
    line(`  memory skill:  ${skill.skillFile} (${skill.skillAction})`);
    line(`  sessionStart:  ${runtime.hooksFile} (${runtime.hookAction})`);
    line(`  MCP server:    ${runtime.mcpFile} (${runtime.mcpAction})`);
    if (synced) line(`  repo AGENTS:   ${synced.agentsFile} (${synced.agentsAction}, ${synced.ruleCount} repo rule(s))`);
    line("");
    line("Cursor reads the repo AGENTS.md (static), injects standing rules at sessionStart, and");
    line("uses the goatedcontext MCP server for per-task retrieval and memory writes.");
    line("Note: user-level sessionStart hooks are unavailable to Cursor CLOUD agents (local editor only);");
    line("project-scoped .cursor/hooks.json and MCP remain the path there.");
  });
}

/**
 * Cursor `sessionStart` hook body. Reads the hook JSON on stdin (`workspace_roots`, …)
 * and emits `{"additional_context": "…"}` on stdout — Cursor requires JSON here. We
 * inject only the STANDING (always-on) preferences appropriate at session start, plus a
 * clear instruction to call the ctx MCP `get_context` tool for task-specific context.
 * Fail OPEN: on ANY error we print `{}` and exit 0 so the Cursor session is never blocked.
 */
async function runCursorSessionHook(deps: CliDeps, debug: boolean): Promise<void> {
  const instruction =
    "goatedcontext is available via the MCP server 'goatedcontext'. Before substantial coding or " +
    "design decisions, call its get_context tool with the current task to retrieve task-specific " +
    "developer preferences and past decision evidence. Persist durable memory only from the user's " +
    "own expressed intent (the remember/propose/record_decision tools, origin=user).";
  try {
    const raw = await readStdin();
    const payload = raw.trim() ? (JSON.parse(raw) as { workspace_roots?: unknown }) : {};
    const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
    const cwd = (typeof roots[0] === "string" && roots[0].length > 0 ? roots[0] : process.cwd()) as string;
    const block = withContext(deps, (ctx) => {
      const result = ctx.retrieval.retrieve({ cwd, track: false });
      // Session start has no task, so only ALWAYS-on rules are meaningful; observed
      // patterns and relevant rules are task-specific and come via MCP get_context.
      const always = result.preferences.filter((p) => p.applicability === "always");
      return renderContextBlock({ ...result, preferences: always, observedPatterns: [] });
    }, { busyTimeoutMs: HOOK_BUSY_TIMEOUT_MS }); // fail open fast on a locked DB
    const additional_context = block ? `${block}\n\n${instruction}` : instruction;
    process.stdout.write(JSON.stringify({ additional_context }) + "\n");
  } catch (err) {
    if (debug) hookDebug(deps, `cursor-session error: ${(err as Error).message}`);
    process.stdout.write("{}\n"); // fail open — never block the Cursor session
  }
}

function uninstallCodexTarget(deps: CliDeps, opts: Record<string, unknown>): void {
  const result = uninstallCodex({
    home: opts.codexHome as string | undefined,
    env: deps.env ?? process.env,
  });
  if (opts.json) return printJson(result);
  line("Removed the ctx Codex adapter. Your preferences and environments are untouched.");
  line(`  prompt hook:   ${result.hooksFile} (${result.hookAction})`);
  line(`  memory skill:  (${result.skillAction})`);
  line("");
  line("The repo's AGENTS.md is shared with Cursor/other agents — remove it with `ctx sync --remove` in the repo.");
}

function uninstallCursorTarget(deps: CliDeps, opts: Record<string, unknown>): void {
  const skill = uninstallCursorSkill({ home: opts.cursorHome as string | undefined });
  const runtime = uninstallCursorRuntime({ home: opts.cursorHome as string | undefined });
  withContext(deps, (ctx) => {
    let unsynced: ReturnType<typeof unsyncProject> | null = null;
    try {
      unsynced = unsyncProject(ctx, (opts.cwd as string) ?? process.cwd());
    } catch {
      /* not in a repo — the global skill/runtime removal still applied */
    }
    if (opts.json) return printJson({ cursorSkill: skill, cursorRuntime: runtime, repoUnsync: unsynced });
    line("Removed the ctx Cursor adapter. Your preferences and environments are untouched.");
    line(`  memory skill:  (${skill.skillAction})`);
    line(`  sessionStart:  (${runtime.hookAction})`);
    line(`  MCP server:    (${runtime.mcpAction})`);
    if (unsynced) line(`  AGENTS.md:     ${unsynced.agentsFile} (${unsynced.agentsAction})`);
  });
}

/**
 * Read a secret value from stdin. ctx never echoes the value back.
 *
 * Two modes, chosen by whether stdin is a terminal:
 *   - interactive TTY: read ONE line (Enter submits), trimmed — the convenient path
 *     for typing/pasting a single token without needing Ctrl-D.
 *   - pipe/redirect (`cat key.pem | …`, `printf … | …`): read the COMPLETE stream to
 *     EOF so MULTILINE secrets (PEM keys, certs, JSON blobs) are preserved. Every
 *     embedded newline is kept verbatim; exactly ONE trailing newline (the shell/echo
 *     artifact) is stripped, and no other whitespace is touched.
 */
async function readSecretFromStdin(varName: string): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    process.stderr.write(`Enter value for ${varName} (read from stdin, not echoed by ctx): `);
    const value = (await readStdinLine()).trim();
    return value.length > 0 ? value : undefined;
  }
  const raw = await readStdin();
  const value = raw.replace(/\r?\n$/, "");
  return value.length > 0 ? value : undefined;
}

/** Compact human label for an audit event type (e.g. "preference.approved" → "approved"). */
function eventLabel(type: string): string {
  const map: Record<string, string> = {
    "preference.remembered": "remembered",
    "preference.proposed": "proposed",
    "preference.evidence_added": "evidence",
    "preference.approved": "approved",
    "preference.rejected": "rejected",
    "preference.locked": "locked",
    "preference.unlocked": "unlocked",
    "preference.forgotten": "forgotten",
    "environment.created": "env+",
    "environment.removed": "env-",
  };
  return map[type] ?? type;
}

/** Best-effort hook diagnostics to <CTX_HOME>/hook.log (only when --debug/CTX_HOOK_DEBUG). */
function hookDebug(deps: CliDeps, msg: string): void {
  try {
    const home = (deps.env ?? process.env).CTX_HOME ?? "";
    appendFileSync((home ? home + "/" : "") + "hook.log", `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* diagnostics are best-effort */
  }
}

function detectClaude(claudeHome?: string): {
  skillsInstalled: boolean;
  instructionsInstalled: boolean;
  hookInstalled: boolean;
} {
  const home = claudeHome ?? join(homedir(), ".claude");
  const skill = join(home, "skills", "context", "SKILL.md");
  const instructions = join(home, "CLAUDE.md");
  let instructionsInstalled = false;
  try {
    instructionsInstalled =
      existsSync(instructions) && readFileSync(instructions, "utf8").includes(CTX_INSTRUCTION_BEGIN);
  } catch {
    instructionsInstalled = false;
  }
  let hookInstalled = false;
  try {
    hookInstalled = detectPromptHook(join(home, "settings.json"));
  } catch {
    hookInstalled = false;
  }
  return { skillsInstalled: existsSync(skill), instructionsInstalled, hookInstalled };
}

/** Entry used by src/index.ts. Handles clean error reporting and exit codes. */
export async function runCli(argv: string[], deps: CliDeps): Promise<void> {
  const program = buildProgram(deps);
  program.exitOverride();
  program.configureOutput({ writeErr: (str) => process.stderr.write(str) });
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof ZodError) {
      const msg = err.issues
        .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
        .join("; ");
      warn(`error: invalid input — ${msg}`);
      process.exitCode = new ValidationError(msg).exitCode;
      return;
    }
    if (err instanceof CtxError) {
      warn(`error: ${err.message}`);
      process.exitCode = err.exitCode;
      return;
    }
    const e = err as { code?: string; exitCode?: number };
    if (e && typeof e.code === "string" && e.code.startsWith("commander.")) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version") return;
      process.exitCode = e.exitCode ?? 1;
      return;
    }
    warn(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
