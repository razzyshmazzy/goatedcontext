import { Command } from "commander";
import { CtxContext } from "../core/context.ts";
import { CtxError } from "../utils/errors.ts";
import { shortId } from "../utils/id.ts";
import { installClaude } from "../adapters/claude/installer.ts";
import { line, printJson, warn } from "./output.ts";
import type { Scope } from "../core/preferences/types.ts";
import type { EnvScope, RiskLevel } from "../core/environments/service.ts";

const VERSION = "0.1.0";

/** Args after a standalone `--`, captured by the entry point for `env run`. */
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

  // ---- remember -----------------------------------------------------------
  program
    .command("remember")
    .description("Explicitly record a developer preference (approved immediately).")
    .argument("<rule>", "The preference rule text")
    .option("--scope <scope>", "global | repo", "global")
    .option("--category <category>", "Preference category", "general")
    .option("--repo", "Shortcut for --scope repo")
    .option("--lock", "Create it as a locked preference (cannot be auto-changed)")
    .option("--evidence <text>", "Optional supporting evidence")
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
          scope,
          repoId,
          status: opts.lock ? "locked" : "approved",
          evidence: opts.evidence,
          source: "explicit",
        });
        if (opts.json) return printJson(pref);
        line(`Remembered [${pref.status}] (${shortId(pref.id)}): ${pref.rule}`);
        line(`  scope=${pref.scope} category=${pref.category}`);
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
    .option("--repo", "Shortcut for --scope repo")
    .option("--source <source>", "Origin of the observation", "agent")
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
          scope,
          repoId,
          evidence: opts.evidence,
          source: opts.source,
        });
        if (opts.json) return printJson(result);
        const p = result.preference;
        const count = ctx.preferences.evidenceCount(p.id);
        if (result.merged) {
          line(`Merged into existing proposal (${shortId(p.id)}); confidence=${p.confidence.toFixed(2)}, evidence=${count}.`);
        } else {
          line(`Proposed (${shortId(p.id)}): ${p.rule}`);
          line(`  scope=${p.scope} category=${p.category} confidence=${p.confidence.toFixed(2)}`);
        }
        line(`Review with: ctx prefs pending`);
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
        if (all.length === 0) return line("No preferences yet. Try: ctx remember \"...\"");
        for (const p of all) {
          line(
            `${shortId(p.id)}  [${p.status}] (${p.scope}/${p.category}) c=${p.confidence.toFixed(2)}  ${p.rule}`,
          );
        }
      });
    });

  prefs
    .command("pending")
    .description("Show proposed preferences awaiting review, with evidence.")
    .option("--json", "Output JSON")
    .action((opts) => {
      withContext(deps, (ctx) => {
        const pending = ctx.preferences.pending();
        const enriched = pending.map((p) => ({
          id: p.id,
          rule: p.rule,
          category: p.category,
          scope: p.scope,
          confidence: p.confidence,
          evidenceCount: ctx.preferences.evidenceCount(p.id),
          evidence: ctx.preferences.evidenceFor(p.id).map((e) => ({
            source: e.source,
            text: e.evidenceText,
            at: e.createdAt,
          })),
        }));
        if (opts.json) return printJson(enriched);
        if (enriched.length === 0) return line("Nothing pending review.");
        for (const p of enriched) {
          line("");
          line(`${shortId(p.id)}  [proposed]  (${p.scope}/${p.category})  confidence=${p.confidence.toFixed(2)}  evidence=${p.evidenceCount}`);
          line(`  rule: ${p.rule}`);
          for (const e of p.evidence) line(`  - (${e.source}) ${e.text}`);
          line(`  approve: ctx prefs approve ${shortId(p.id)}   reject: ctx prefs reject ${shortId(p.id)}`);
        }
      });
    });

  prefs
    .command("approve")
    .description("Approve a proposed preference so it takes effect.")
    .argument("<id>", "Preference id (or unique prefix)")
    .option("--json", "Output JSON")
    .action((id, opts) => {
      withContext(deps, (ctx) => {
        const pref = ctx.preferences.resolveRef(id);
        const updated = ctx.preferences.approve(pref.id);
        if (opts.json) return printJson(updated);
        line(`Approved (${shortId(updated.id)}): ${updated.rule}`);
      });
    });

  prefs
    .command("reject")
    .description("Reject a preference (kept for audit, never retrieved).")
    .argument("<id>", "Preference id (or unique prefix)")
    .option("--json", "Output JSON")
    .action((id, opts) => {
      withContext(deps, (ctx) => {
        const pref = ctx.preferences.resolveRef(id);
        const updated = ctx.preferences.reject(pref.id);
        if (opts.json) return printJson(updated);
        line(`Rejected (${shortId(updated.id)}): ${updated.rule}`);
      });
    });

  // ---- forget -------------------------------------------------------------
  program
    .command("forget")
    .description("Permanently delete a preference and its evidence.")
    .argument("<id>", "Preference id (or unique prefix)")
    .option("--json", "Output JSON")
    .action((id, opts) => {
      withContext(deps, (ctx) => {
        const pref = ctx.preferences.resolveRef(id);
        ctx.preferences.forget(pref.id);
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
        if (opts.json) {
          return printJson({ preference: pref, repo, evidence });
        }
        line(`Preference ${pref.id}`);
        line(`  rule:       ${pref.rule}`);
        line(`  category:   ${pref.category}`);
        line(`  scope:      ${pref.scope}${repo ? ` (${repo.name})` : ""}`);
        line(`  status:     ${pref.status}`);
        line(`  confidence: ${pref.confidence.toFixed(2)}`);
        line(`  created:    ${pref.createdAt}`);
        line(`  last used:  ${pref.lastUsedAt ?? "never"}`);
        line(`  evidence (${evidence.length}):`);
        for (const e of evidence) line(`    - (${e.source}) ${e.evidenceText}`);
        line("");
        line("This preference exists because it was recorded from the evidence above and");
        line("has not been rejected. Repo preferences override global ones during retrieval.");
      });
    });

  // ---- get ----------------------------------------------------------------
  program
    .command("get")
    .description("Retrieve ranked, conflict-resolved context for the current repo & task (JSON).")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option("--task <text>", "Description of the current task")
    .option("--limit <n>", "Max preferences to return (1-15)", (v) => parseInt(v, 10))
    .option("--include-proposed", "Also include proposed/observed preferences")
    .action((opts) => {
      withContext(deps, (ctx) => {
        const result = ctx.retrieval.retrieve({
          cwd: opts.cwd,
          task: opts.task,
          limit: opts.limit,
          includeProposed: Boolean(opts.includeProposed),
        });
        printJson(result);
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
    .option("--lock", "Create it as a locked preference")
    .option("--evidence <text>", "Optional supporting evidence")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option("--json", "Output JSON")
    .action((rule, opts) => {
      withContext(deps, (ctx) => {
        const r = resolveRepoOrThrow(ctx, opts.cwd);
        const pref = ctx.preferences.remember({
          rule,
          category: opts.category,
          scope: "repo",
          repoId: r.id,
          status: opts.lock ? "locked" : "approved",
          evidence: opts.evidence,
          source: "explicit",
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
    .action((name, varName, opts) => {
      withContext(deps, (ctx) => {
        const repo = ctx.repos.resolve(opts.cwd);
        const environment = ctx.environments.requireByName(name, repo?.id ?? null);
        let value: string | undefined = opts.value;
        if (value == null && opts.fromEnv) {
          value = (deps.env ?? process.env)[opts.fromEnv];
          if (value == null) {
            throw new CtxError(`Env var "${opts.fromEnv}" is not set in the current process.`);
          }
        }
        if (value == null) {
          throw new CtxError(
            "Provide a value with --value <v> or --from-env <NAME>. (ctx never prints the value.)",
          );
        }
        ctx.environments.setVariable(environment.id, varName, value);
        // Deliberately do NOT echo the value.
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
        throw new CtxError('Provide a command after "--", e.g. ctx env run test-api -- npm test');
      }
      await withContext(deps, async (ctx) => {
        const repo = ctx.repos.resolve(opts.cwd);
        const resolved = names.map((n) => ctx.environments.requireByName(n, repo?.id ?? null));
        const injected = ctx.environments.resolveVariables(resolved);

        const [cmd, ...cmdArgs] = passthrough;
        const child = Bun.spawn([cmd!, ...cmdArgs], {
          cwd: opts.cwd,
          // Merge (never print) secrets into the child environment only.
          env: { ...(deps.env ?? process.env), ...injected },
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        const code = await child.exited;
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

  // ---- install ------------------------------------------------------------
  program
    .command("install")
    .description("Install an agent adapter. Supported targets: claude")
    .argument("<target>", "Adapter target (claude)")
    .option("--claude-home <dir>", "Override the Claude config dir (~/.claude)")
    .option("--json", "Output JSON")
    .action((target, opts) => {
      if (target !== "claude") {
        throw new CtxError(`Unknown install target "${target}". Supported: claude`);
      }
      const result = installClaude({ claudeHome: opts.claudeHome });
      if (opts.json) return printJson(result);
      line("Installed Claude Code adapter.");
      line(`  skills dir:    ${result.skillsDir}`);
      line(`  skills:        ${result.installedSkills.join(", ")}`);
      line(`  instructions:  ${result.instructionsFile} (${result.instructionsAction})`);
    });

  return program;
}

/** Entry used by src/index.ts. Handles clean error reporting and exit codes. */
export async function runCli(argv: string[], deps: CliDeps): Promise<void> {
  const program = buildProgram(deps);
  program.exitOverride();
  program.configureOutput({
    writeErr: (str) => process.stderr.write(str),
  });
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CtxError) {
      warn(`error: ${err.message}`);
      process.exitCode = err.exitCode;
      return;
    }
    // commander throws for help/version/parse errors; it already printed output.
    const e = err as { code?: string; exitCode?: number };
    if (e && typeof e.code === "string" && e.code.startsWith("commander.")) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version") {
        return;
      }
      process.exitCode = e.exitCode ?? 1;
      return;
    }
    warn(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
