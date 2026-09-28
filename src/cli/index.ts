import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { ZodError } from "zod";
import { CtxContext } from "../core/context.ts";
import { CtxError, ValidationError } from "../utils/errors.ts";
import { shortId } from "../utils/id.ts";
import { installClaude, repairClaude, uninstallClaude } from "../adapters/claude/installer.ts";
import { CTX_INSTRUCTION_BEGIN } from "../adapters/claude/skills.ts";
import { detectPromptHook, formatHookContext } from "../adapters/claude/hook.ts";
import { simulateHook } from "../adapters/claude/test-hook.ts";
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
import type { Scope } from "../core/preferences/types.ts";
import type { EnvScope, RiskLevel } from "../core/environments/service.ts";

/** Args after a `--`/`--exec` separator, captured by the entry point for `env run`. */
export interface CliDeps {
  passthrough: string[] | null;
  env?: NodeJS.ProcessEnv;
}

function withContext<T>(deps: CliDeps, fn: (ctx: CtxContext) => T): T {
  const ctx = CtxContext.open(deps.env ?? process.env);
  try {
    return fn(ctx);
  } finally {
    ctx.close();
  }
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
    .description("One command to install everything: initialize ctx, install the Claude Code adapter, and make `ctx` persistent.")
    .option("--claude-home <dir>", "Override the Claude config dir (~/.claude)")
    .option("--skip-global", "Don't install a persistent global `ctx` (advanced/manual installs)")
    .option("--json", "Output JSON")
    .action((opts) => {
      const result = runSetup({
        env: deps.env ?? process.env,
        version: VERSION,
        claudeHome: opts.claudeHome,
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

  // ---- remember -----------------------------------------------------------
  program
    .command("remember")
    .description("Explicitly record a developer preference (approved immediately).")
    .argument("<rule>", "The preference rule text")
    .option("--scope <scope>", "global | repo", "global")
    .option("--category <category>", "Preference category", "general")
    .option("--domain <domain>", "Explicit decision domain (optional)")
    .option("--repo", "Shortcut for --scope repo")
    .option("--lock", "Create it as a locked preference (cannot be auto-changed)")
    .option("--evidence <text>", "Optional supporting evidence")
    .option("--agent-id <id>", "Provenance: which agent recorded this")
    .option("--session-id <id>", "Provenance: session identifier")
    .option("--cwd <dir>", "Working directory used to resolve the repo", process.cwd())
    .option("--json", "Output JSON")
    .action((rule, opts) => {
      withContext(deps, (ctx) => {
        const scope: Scope = opts.repo ? "repo" : (opts.scope as Scope);
        let repoId: string | null = null;
        if (scope === "repo") repoId = resolveRepoOrThrow(ctx, opts.cwd).id;
        const pref = ctx.preferences.remember({
          rule,
          category: opts.category,
          domain: opts.domain ?? null,
          scope,
          repoId,
          status: opts.lock ? "locked" : "approved",
          evidence: opts.evidence,
          source: "explicit",
          ...provenance(opts),
        });
        if (opts.json) return printJson(pref);
        line(`Remembered [${pref.status}] (${shortId(pref.id)}): ${pref.rule}`);
        line(`  scope=${pref.scope} category=${pref.category} domain=${pref.domain ?? "-"} polarity=${pref.polarity}`);
      });
    });

  // ---- propose ------------------------------------------------------------
  program
    .command("propose")
    .description("Propose a preference inferred by an agent (needs review to take effect).")
    .argument("<rule>", "The proposed rule text")
    .requiredOption("--evidence <text>", "What was observed that implies this rule")
    .option("--scope <scope>", "global | repo", "global")
    .option("--category <category>", "Preference category", "general")
    .option("--domain <domain>", "Explicit decision domain (optional)")
    .option("--repo", "Shortcut for --scope repo")
    .option("--source <source>", "Origin of the observation", "agent")
    .option("--agent-id <id>", "Provenance: which agent proposed this")
    .option("--session-id <id>", "Provenance: session identifier")
    .option("--cwd <dir>", "Working directory used to resolve the repo", process.cwd())
    .option("--json", "Output JSON")
    .action((rule, opts) => {
      withContext(deps, (ctx) => {
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
          source: opts.source,
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
          line(`  scope=${p.scope} category=${p.category} domain=${p.domain ?? "-"} polarity=${p.polarity} confidence=${p.confidence.toFixed(2)}`);
        }
        line("Review with: ctx prefs pending");
      });
    });

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
          line(
            `${shortId(p.id)}  [${p.status}] (${p.scope}/${p.category}/${p.domain ?? "-"}) ${p.polarity} c=${p.confidence.toFixed(2)}  ${p.rule}`,
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
          line(`${shortId(p.id)}  [proposed]  (${p.scope}/${p.category}/${p.domain ?? "-"})  ${p.polarity}  confidence=${p.confidence.toFixed(2)}  evidence=${p.evidenceCount}`);
          line(`  rule: ${p.rule}`);
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
    .action((id, opts) => {
      withContext(deps, (ctx) => {
        const pref = ctx.preferences.resolveRef(id);
        const updated = ctx.preferences.approve(pref.id, { expectedVersion: pref.version, force: opts.force });
        if (opts.json) return printJson(updated);
        line(`Approved (${shortId(updated.id)}): ${updated.rule}`);
      });
    });

  prefs
    .command("reject")
    .description("Reject a preference (kept for audit, never retrieved).")
    .argument("<id>", "Preference id (or unique prefix)")
    .option("--force", "Apply even if the preference changed since you read it")
    .option("--json", "Output JSON")
    .action((id, opts) => {
      withContext(deps, (ctx) => {
        const pref = ctx.preferences.resolveRef(id);
        const updated = ctx.preferences.reject(pref.id, { expectedVersion: pref.version, force: opts.force });
        if (opts.json) return printJson(updated);
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
    .option("--limit <n>", "Max events to show", (v) => parseInt(v, 10), 20)
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
    .option("--limit <n>", "Max preferences to return (1-15)", (v) => parseInt(v, 10))
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

  // ---- hook (internal: called by Claude Code UserPromptSubmit) -------------
  program
    .command("hook")
    .description("Internal: proactive-retrieval hook invoked by Claude Code. Reads hook JSON on stdin.")
    .argument("<event>", "Hook event (claude-prompt)")
    .option("--debug", "Write diagnostics to <ctx home>/hook.log")
    .action(async (event, opts) => {
      // Fail OPEN: this must never make Claude unusable. Any error → no output,
      // exit 0, so Claude proceeds with the user's original prompt untouched.
      const debug = opts.debug || (deps.env ?? process.env).CTX_HOOK_DEBUG;
      try {
        if (event !== "claude-prompt") return;
        const raw = await readStdin();
        if (!raw.trim()) return;
        const payload = JSON.parse(raw) as { cwd?: string; prompt?: string };
        const prompt = (payload.prompt ?? "").toString();
        if (!prompt.trim()) return;
        const cwd = payload.cwd && payload.cwd.trim().length > 0 ? payload.cwd : process.cwd();
        withContext(deps, (ctx) => {
          const result = ctx.retrieval.retrieve({ cwd, task: prompt, track: false });
          const block = formatHookContext(result);
          // Emit the injected block BEFORE touching stats, so a stats write can
          // never affect what Claude receives. Stats recording is itself fail-open.
          if (block) process.stdout.write(block + "\n");
          if (block) ctx.stats.recordHookInjection(result.preferences.length);
          else ctx.stats.recordHookNoMatch();
          if (debug) hookDebug(deps, `fired injected=${block ? "yes" : "no"} n=${result.preferences.length} cwd=${cwd}`);
        });
      } catch (err) {
        if (debug) hookDebug(deps, `error: ${(err as Error).message}`);
        // swallow — fail open
      }
    });

  // ---- test-hook (debug the prompt-retrieval hook without launching Claude) --
  program
    .command("test-hook")
    .description("Dry-run the Claude prompt-retrieval hook for a task, without launching Claude.")
    .requiredOption("--task <text>", "The task/prompt to simulate")
    .option("--cwd <dir>", "Working directory used to resolve the repo", process.cwd())
    .option("--json", "Output JSON")
    .action((opts) => {
      withContext(deps, (ctx) => {
        const result = simulateHook(ctx, { cwd: opts.cwd, task: opts.task });
        if (opts.json) return printJson(result);

        line(`Task: ${result.task.trim() ? result.task : "(empty)"}`);
        line(
          `Repository: ${result.repo ? `${result.repo.name} (${result.repo.identity})` : "(none / not a git repo)"}`,
        );
        line(`Would inject context: ${result.wouldInject ? "yes" : "no"}`);
        line("");
        line(`Matched preferences (${result.preferences.length}):`);
        if (result.preferences.length === 0) line("  (none)");
        for (const p of result.preferences) {
          const domain = p.domain ? `/${p.domain}` : "";
          line(`  - [${p.scope}${domain}] ${p.rule}  (relevance=${p.relevance.toFixed(2)})`);
        }
        if (result.overridden.length > 0) {
          line("");
          line(`Suppressed by higher-precedence rules (${result.overridden.length}):`);
          for (const o of result.overridden) {
            line(`  - (${shortId(o.id)}) ${o.rule}  →  superseded by ${shortId(o.supersededBy)}`);
          }
        }
        line("");
        if (result.block) {
          line("Injected context block:");
          line("----------------------------------------");
          line(result.block);
          line("----------------------------------------");
        } else {
          line("Injected context block: (nothing would be injected)");
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
    .option("--evidence <text>", "Optional supporting evidence")
    .option("--agent-id <id>", "Provenance: which agent recorded this")
    .option("--session-id <id>", "Provenance: session identifier")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option("--json", "Output JSON")
    .action((rule, opts) => {
      withContext(deps, (ctx) => {
        const r = resolveRepoOrThrow(ctx, opts.cwd);
        const pref = ctx.preferences.remember({
          rule,
          category: opts.category,
          domain: opts.domain ?? null,
          scope: "repo",
          repoId: r.id,
          status: opts.lock ? "locked" : "approved",
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
        const code = runChildInherit(cmd!, cmdArgs, { cwd: opts.cwd, env: childEnv });
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

  // ---- export -------------------------------------------------------------
  program
    .command("export")
    .description("Export preferences, evidence and repo links as a portable JSON bundle. Never exports secrets.")
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
    .description("Install an agent adapter. Supported targets: claude")
    .argument("<target>", "Adapter target (claude)")
    .option("--claude-home <dir>", "Override the Claude config dir (~/.claude)")
    .option("--hook-command <cmd>", "Command Claude runs for the prompt hook", "ctx hook claude-prompt")
    .option("--disable-hook", "Remove the proactive-retrieval hook (keeps skills & preferences)")
    .option("--repair", "Rewrite any missing/corrupt ctx files and restore the hook")
    .option("--json", "Output JSON")
    .action((target, opts) => {
      if (target !== "claude") {
        throw new CtxError(`Unknown install target "${target}". Supported: claude`);
      }
      const hookLabelOf = (a: string) =>
        a === "error"
          ? "NOT configured (existing settings.json is not valid JSON — left untouched)"
          : a;

      if (opts.repair) {
        const result = repairClaude({
          claudeHome: opts.claudeHome,
          hookCommand: opts.hookCommand,
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
        hookCommand: opts.hookCommand,
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
    .description("Remove a ctx agent adapter (skills, instruction block, hook). Keeps your preferences & environments.")
    .argument("<target>", "Adapter target (claude)")
    .option("--claude-home <dir>", "Override the Claude config dir (~/.claude)")
    .option("--json", "Output JSON")
    .action((target, opts) => {
      if (target !== "claude") {
        throw new CtxError(`Unknown uninstall target "${target}". Supported: claude`);
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

  return program;
}

/**
 * Read a single secret value from stdin (one line). Works with a pipe
 * (`echo $KEY | ctx env set …`) and interactively (type/paste the value, Enter).
 * ctx never echoes the value back.
 */
async function readSecretFromStdin(varName: string): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    process.stderr.write(`Enter value for ${varName} (read from stdin, not echoed by ctx): `);
  }
  const value = (await readStdinLine()).trim();
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
