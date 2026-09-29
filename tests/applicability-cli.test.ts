import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { PreferenceService } from "../src/core/preferences/service.ts";

// End-to-end CLI coverage for applicability, using spawned `ctx` processes so the
// hook/validation/concurrency paths are exercised exactly as in production.

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const TIMEOUT = 90_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "ctx-appl-cli-"));
}

function run(args: string[], home: string, stdin?: string): Promise<RunResult> {
  const proc = Bun.spawn([BUN, "run", INDEX, ...args], {
    cwd: home,
    env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    stdin: stdin !== undefined ? Buffer.from(stdin, "utf8") : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  return (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  })();
}

function hook(home: string, prompt: string): Promise<RunResult> {
  return run(["hook", "claude-prompt"], home, JSON.stringify({ cwd: home, prompt }));
}

// ---- the original reproduction ---------------------------------------------

test(
  "REPRODUCTION: `always respond in italian` is injected for the prompt `hi`",
  async () => {
    const home = freshHome();
    const r = await run(
      ["remember", "--scope", "global", "--category", "general", "always respond in italian"],
      home,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("applicability=always"); // inferred

    const th = await run(["test-hook", "--task", "hi", "--json"], home);
    const parsed = JSON.parse(th.stdout);
    expect(parsed.wouldInject).toBe(true);
    const injectedRules = parsed.preferences.map((p: { rule: string }) => p.rule);
    expect(injectedRules).toContain("always respond in italian");
    expect(parsed.block).toContain("always respond in italian");
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "database-relevant rule is NOT injected for `hi`, but IS for a database task",
  async () => {
    const home = freshHome();
    await run(["remember", "--scope", "global", "--category", "general", "always respond in italian"], home);
    await run(
      ["remember", "--scope", "global", "--category", "database", "Prefer relational constraints for important integrity rules."],
      home,
    );

    const hi = JSON.parse((await run(["test-hook", "--task", "hi", "--json"], home)).stdout);
    const hiRules = hi.preferences.map((p: { rule: string }) => p.rule);
    expect(hiRules).toContain("always respond in italian");
    expect(hiRules).not.toContain("Prefer relational constraints for important integrity rules.");

    const dbTask = JSON.parse(
      (await run(["test-hook", "--task", "design a database schema with constraints", "--json"], home)).stdout,
    );
    const dbRules = dbTask.preferences.map((p: { rule: string }) => p.rule);
    expect(dbRules).toContain("always respond in italian");
    expect(dbRules).toContain("Prefer relational constraints for important integrity rules.");
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

// ---- the live hook path -----------------------------------------------------

test(
  "the real hook injects the always-on rule automatically for an unrelated prompt",
  async () => {
    const home = freshHome();
    await run(["remember", "--scope", "global", "--always", "Always respond in Italian."], home);
    const r = await hook(home, "hi");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("<ctx-developer-context>");
    expect(r.stdout).toContain("Always respond in Italian.");
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

// ---- explicit flags + validation -------------------------------------------

test(
  "--always and --applicability create the right applicability",
  async () => {
    const home = freshHome();
    const a = await run(["remember", "--scope", "global", "--always", "Prefer concise output."], home);
    expect(a.stdout).toContain("applicability=always");
    const b = await run(
      ["remember", "--scope", "global", "--applicability", "relevant", "Always respond in Italian."],
      home,
    );
    expect(b.stdout).toContain("applicability=relevant"); // explicit overrides inference
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "invalid applicability value fails cleanly with no write",
  async () => {
    const home = freshHome();
    const r = await run(["remember", "--scope", "global", "--applicability", "banana", "Some rule."], home);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("applicability");
    const list = JSON.parse((await run(["prefs", "--json"], home)).stdout);
    expect(list).toHaveLength(0); // nothing persisted
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "conflicting --always with --applicability relevant is rejected",
  async () => {
    const home = freshHome();
    const r = await run(
      ["remember", "--scope", "global", "--always", "--applicability", "relevant", "Some rule."],
      home,
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("conflicting");
    const list = JSON.parse((await run(["prefs", "--json"], home)).stdout);
    expect(list).toHaveLength(0);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

// ---- inspection surfaces ----------------------------------------------------

test(
  "applicability is visible in prefs, why, and test-hook output",
  async () => {
    const home = freshHome();
    await run(["remember", "--scope", "global", "--always", "Always respond in Italian."], home);

    const prefs = await run(["prefs"], home);
    expect(prefs.stdout).toContain("always");

    const prefsJson = JSON.parse((await run(["prefs", "--json"], home)).stdout);
    expect(prefsJson[0].applicability).toBe("always");

    const id = prefsJson[0].id as string;
    const why = await run(["why", id], home);
    expect(why.stdout).toContain("applicability: always");

    const th = await run(["test-hook", "--task", "hi"], home);
    expect(th.stdout).toContain("[always]");
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

// ---- concurrency ------------------------------------------------------------

test(
  "20 concurrent hooks with an always rule inject it every time; stats exact; no locks",
  async () => {
    const home = freshHome();
    // Seed one always rule and one relevant rule directly (avoid write races in setup).
    const db = openDatabase(resolvePaths({ CTX_HOME: home }));
    try {
      const p = new PreferenceService(db);
      p.remember({ rule: "Always respond in Italian.", scope: "global" });
      p.remember({
        rule: "Prefer relational constraints for important integrity rules.",
        category: "database",
        scope: "global",
      });
    } finally {
      db.close();
    }

    const N = 20;
    const results = await Promise.all(Array.from({ length: N }, () => hook(home, "hi")));
    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.stderr).not.toMatch(/database is locked/i);
      expect(r.stdout).toContain("Always respond in Italian."); // always injected every time
      expect(r.stdout).not.toContain("relational constraints"); // relevant not injected for "hi"
      // No duplicate injection of the always rule.
      expect(r.stdout.split("Always respond in Italian.").length - 1).toBe(1);
    }

    const stats = JSON.parse((await run(["stats", "--json"], home)).stdout);
    expect(stats.hook_runs).toBe(N);
    expect(stats.context_injections).toBe(N);
    expect(stats.no_match).toBe(0);
    expect(stats.preferences_injected).toBe(N); // exactly one pref per hook
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "mixed concurrent hooks: always-only vs always+relevant tally exactly",
  async () => {
    const home = freshHome();
    const db = openDatabase(resolvePaths({ CTX_HOME: home }));
    try {
      const p = new PreferenceService(db);
      p.remember({ rule: "Always respond in Italian.", scope: "global" });
      p.remember({
        rule: "Prefer existing dependencies before adding a new package.",
        category: "dependencies",
        scope: "global",
      });
    } finally {
      db.close();
    }

    const tasks: Promise<RunResult>[] = [];
    for (let i = 0; i < 10; i++) tasks.push(hook(home, "hi")); // always only → 1 pref
    for (let i = 0; i < 10; i++) tasks.push(hook(home, "install a new package dependency")); // always + relevant → 2
    const results = await Promise.all(tasks);
    for (const r of results) expect(r.code).toBe(0);

    const stats = JSON.parse((await run(["stats", "--json"], home)).stdout);
    expect(stats.hook_runs).toBe(20);
    expect(stats.context_injections).toBe(20);
    expect(stats.no_match).toBe(0);
    expect(stats.preferences_injected).toBe(10 * 1 + 10 * 2);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);
