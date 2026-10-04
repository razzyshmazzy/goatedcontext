import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end multi-agent CLI coverage through spawned `ctx` processes, exercising the
// corrected 0.2.9 delivery policy exactly as in production.

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const TIMEOUT = 90_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function home(): string {
  return mkdtempSync(join(tmpdir(), "ctx-ma-"));
}

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ctx-ma-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: root, stdio: "ignore" });
  return root;
}

function run(args: string[], env: Record<string, string>, stdin?: string): Promise<RunResult> {
  const proc = Bun.spawn([BUN, "run", INDEX, ...args], {
    env: { ...process.env, CTX_SECRET_BACKEND: "file", ...env },
    stdin: stdin !== undefined ? Buffer.from(stdin, "utf8") : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  return (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  })();
}

/** Seed the canonical global-always + repo-always rules. */
async function seed(env: Record<string, string>, repo: string) {
  await run(["remember", "--always", "Never add dependencies without asking."], env);
  await run(["remember", "--scope", "repo", "--cwd", repo, "--always", "Use Bun for development commands."], env);
}

test(
  "sync materializes ONLY repo-always into AGENTS.md (no global leakage, no .cursor/rules)",
  async () => {
    const h = home();
    const repo = gitRepo();
    const env = { CTX_HOME: h };
    try {
      await seed(env, repo);
      await run(["remember", "--scope", "repo", "--cwd", repo, "Prefer foreign keys."], env); // relevant
      const res = await run(["sync", "--cwd", repo], env);
      expect(res.code).toBe(0);
      const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
      expect(agents).toContain("Use Bun for development commands."); // repo always
      expect(agents).not.toContain("Never add dependencies without asking."); // global always excluded
      expect(agents).not.toContain("Prefer foreign keys."); // relevant excluded
      expect(existsSync(join(repo, ".cursor", "rules", "goatedcontext.mdc"))).toBe(false);
    } finally {
      rmSync(h, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "install codex: hook only, NO global ~/.codex/AGENTS.md; repo synced",
  async () => {
    const h = home();
    const codexHome = mkdtempSync(join(tmpdir(), "ctx-ma-codex-"));
    const repo = gitRepo();
    const env = { CTX_HOME: h, CODEX_HOME: codexHome };
    try {
      await seed(env, repo);
      const res = await run(["install", "codex", "--cwd", repo], env);
      expect(res.code).toBe(0);
      expect(existsSync(join(codexHome, "hooks.json"))).toBe(true);
      expect(existsSync(join(codexHome, "AGENTS.md"))).toBe(false); // corrected: no global AGENTS.md
      expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toContain("Use Bun for development commands.");
    } finally {
      rmSync(h, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "DEDUP: codex-prompt hook injects global-always but NOT repo-always (that's in AGENTS.md); claude injects both",
  async () => {
    const h = home();
    const repo = gitRepo();
    const env = { CTX_HOME: h };
    try {
      await seed(env, repo);
      const payload = JSON.stringify({ cwd: repo, prompt: "install a date parsing package" });
      const codex = await run(["hook", "codex-prompt"], env, payload);
      expect(codex.code).toBe(0);
      expect(codex.stdout).toContain("Never add dependencies without asking."); // global always → runtime
      expect(codex.stdout).not.toContain("Use Bun for development commands."); // repo always → static, deduped

      const claude = await run(["hook", "claude-prompt"], env, payload);
      expect(claude.stdout).toContain("Never add dependencies without asking.");
      expect(claude.stdout).toContain("Use Bun for development commands."); // Claude: no static dedup
    } finally {
      rmSync(h, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "ctx agents reports capabilities; Cursor runtime unavailable",
  async () => {
    const h = home();
    const repo = gitRepo();
    const env = { CTX_HOME: h };
    try {
      const human = await run(["agents", "--cwd", repo], env);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("Claude Code");
      expect(human.stdout).toContain("Codex");
      expect(human.stdout).toContain("Cursor");
      expect(human.stdout).toContain("runtime unavailable"); // Cursor

      const json = JSON.parse((await run(["agents", "--cwd", repo, "--json"], env)).stdout);
      const cursor = json.find((a: { id: string }) => a.id === "cursor");
      expect(cursor.capabilities.runtimePromptInjection).toBe(false);
      const codex = json.find((a: { id: string }) => a.id === "codex");
      expect(codex.capabilities.staticAgentsMd).toBe(true);
      expect(codex.capabilities.runtimePromptInjection).toBe(true);
    } finally {
      rmSync(h, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "test-hook --agent cursor is honest: runtime unsupported, static plan shown, no fabricated block",
  async () => {
    const h = home();
    const repo = gitRepo();
    const env = { CTX_HOME: h };
    try {
      await seed(env, repo);
      const json = JSON.parse(
        (await run(["test-hook", "--agent", "cursor", "--task", "do work", "--cwd", repo, "--json"], env)).stdout,
      );
      expect(json.runtimeSupported).toBe(false);
      expect(json.block).toBeNull();
      expect(json.plan.static.map((e: { rule: string }) => e.rule)).toContain("Use Bun for development commands.");
      expect(json.plan.unsupported.map((e: { rule: string }) => e.rule)).toContain("Never add dependencies without asking.");

      const human = await run(["test-hook", "--agent", "cursor", "--task", "do work", "--cwd", repo], env);
      expect(human.stdout).toContain("UNSUPPORTED");
    } finally {
      rmSync(h, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "per-agent stats: codex hook runs are counted under the codex key (old files still read)",
  async () => {
    const h = home();
    const repo = gitRepo();
    const env = { CTX_HOME: h };
    try {
      await seed(env, repo);
      const payload = JSON.stringify({ cwd: repo, prompt: "install a package" });
      for (let i = 0; i < 3; i++) await run(["hook", "codex-prompt"], env, payload);
      await run(["hook", "claude-prompt"], env, payload);
      const stats = JSON.parse((await run(["stats", "--json"], env)).stdout);
      expect(stats.context_injections_by_agent.codex).toBe(3);
      expect(stats.context_injections_by_agent.claude).toBe(1);
      expect(stats.hook_runs).toBe(4); // aggregate preserved
    } finally {
      rmSync(h, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "setup auto-detects installed agents, configures them, and never fails on an absent one",
  async () => {
    const h = home();
    const claudeHome = mkdtempSync(join(tmpdir(), "ctx-ma-claude-"));
    const codexHome = mkdtempSync(join(tmpdir(), "ctx-ma-codex2-"));
    const repo = gitRepo();
    // Isolate HOME/USERPROFILE so Cursor (~/.cursor) is deterministically absent.
    const fakeHome = mkdtempSync(join(tmpdir(), "ctx-ma-fakehome-"));
    const env = { CTX_HOME: h, HOME: fakeHome, USERPROFILE: fakeHome };
    try {
      await seed(env, repo);
      // claudeHome + codexHome exist → both detected; cursor (~/.cursor under fakeHome) absent.
      const res = await run(
        ["setup", "--skip-global", "--claude-home", claudeHome, "--codex-home", codexHome, "--cwd", repo],
        env,
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("Claude integration");
      expect(res.stdout).toContain("Codex integration");
      expect(res.stdout).toContain("Restart Claude Code."); // Claude WAS configured
      expect(existsSync(join(codexHome, "hooks.json"))).toBe(true);
      // Cursor absent → not configured, and setup still succeeded.
      expect(res.stdout).not.toContain("Cursor integration");
    } finally {
      for (const d of [h, claudeHome, codexHome, repo, fakeHome]) rmSync(d, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "setup with no supported agents still sets up ctx successfully (no restart-Claude line)",
  async () => {
    const h = home();
    const fakeHome = mkdtempSync(join(tmpdir(), "ctx-ma-fakehome2-"));
    const missingClaude = join(fakeHome, "no-claude");
    const missingCodex = join(fakeHome, "no-codex");
    const env = { CTX_HOME: h, HOME: fakeHome, USERPROFILE: fakeHome };
    try {
      const res = await run(
        ["setup", "--skip-global", "--claude-home", missingClaude, "--codex-home", missingCodex, "--cwd", fakeHome],
        env,
      );
      expect(res.code).toBe(0); // success even with zero agents
      expect(res.stdout).not.toContain("Claude integration");
      expect(res.stdout).not.toContain("Restart Claude Code.");
    } finally {
      rmSync(h, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);
