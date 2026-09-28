import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestContext } from "./helpers.ts";
import { simulateHook } from "../src/adapters/claude/test-hook.ts";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { PreferenceService } from "../src/core/preferences/service.ts";

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const TIMEOUT = 60_000;

/** A directory that is NOT inside any git repository. */
function nonRepoDir(): string {
  return mkdtempSync(join(tmpdir(), "ctx-testhook-norepo-"));
}

test("relevant task would inject a context block with the matched preference", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({
    rule: "Prefer existing dependencies before adding a new package.",
    category: "dependencies",
    scope: "global",
  });
  const result = simulateHook(t.ctx, {
    cwd: process.cwd(),
    task: "Install a date parsing package.",
  });
  expect(result.wouldInject).toBe(true);
  expect(result.block).toContain("<ctx-developer-context>");
  expect(result.preferences.some((p) => p.rule.includes("existing dependencies"))).toBe(true);
  t.cleanup();
});

test("irrelevant task injects nothing", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({
    rule: "Prefer relational constraints and database-enforced invariants.",
    category: "database",
    scope: "global",
  });
  const result = simulateHook(t.ctx, {
    cwd: process.cwd(),
    task: "Rename the local variable x to count.",
  });
  expect(result.wouldInject).toBe(false);
  expect(result.block).toBeNull();
  expect(result.preferences).toHaveLength(0);
  t.cleanup();
});

test("a repo rule overrides a conflicting global rule (shown as suppressed)", () => {
  const t = makeTestContext();
  const repo = t.ctx.repos.resolve(process.cwd());
  expect(repo).not.toBeNull();

  // Same exclusive domain (package-manager): repo wins, global is superseded.
  const globalPref = t.ctx.preferences.remember({
    rule: "Prefer pnpm for package management.",
    category: "dependencies",
    domain: "package-manager",
    scope: "global",
  });
  t.ctx.preferences.remember({
    rule: "Use npm for package management in this repo.",
    category: "dependencies",
    domain: "package-manager",
    scope: "repo",
    repoId: repo!.id,
  });

  const result = simulateHook(t.ctx, {
    cwd: process.cwd(),
    task: "Add a new npm package to the project.",
  });

  expect(result.repo?.id).toBe(repo!.id);
  // The repo rule is the one injected; the global rule is suppressed.
  expect(result.preferences.some((p) => p.scope === "repo" && p.rule.includes("npm"))).toBe(true);
  expect(result.overridden.some((o) => o.id === globalPref.id)).toBe(true);
  t.cleanup();
});

test("no repo: repo is null but global rules still match", () => {
  const t = makeTestContext();
  const dir = nonRepoDir();
  t.ctx.preferences.remember({
    rule: "Prefer existing dependencies before adding a new package.",
    category: "dependencies",
    scope: "global",
  });
  const result = simulateHook(t.ctx, { cwd: dir, task: "Install a new package." });
  expect(result.repo).toBeNull();
  expect(result.wouldInject).toBe(true);
  rmSync(dir, { recursive: true, force: true });
  t.cleanup();
});

test("malformed (empty/whitespace) task injects nothing and does not throw", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({
    rule: "Prefer existing dependencies before adding a new package.",
    category: "dependencies",
    scope: "global",
  });
  const result = simulateHook(t.ctx, { cwd: process.cwd(), task: "   \n  " });
  expect(result.wouldInject).toBe(false);
  expect(result.block).toBeNull();
  expect(result.preferences).toHaveLength(0);
  t.cleanup();
});

test("simulation never surfaces secret values", () => {
  const t = makeTestContext();
  const env = t.ctx.environments.add({ name: "supabase-test" });
  const secret = "FAKE_SECRET_sb_zzz_123";
  t.ctx.environments.setVariable(env.id, "SUPABASE_ANON_KEY", secret);
  t.ctx.preferences.remember({
    rule: "Prefer existing dependencies before adding a new package.",
    category: "dependencies",
    scope: "global",
  });
  const result = simulateHook(t.ctx, {
    cwd: process.cwd(),
    task: "Install a package and call the supabase API.",
  });
  expect(JSON.stringify(result)).not.toContain(secret);
  t.cleanup();
});

test(
  "test-hook --json emits a valid dry-run report over the CLI",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-testhook-cli-"));
    const db = openDatabase(resolvePaths({ CTX_HOME: home }));
    try {
      new PreferenceService(db).remember({
        rule: "Prefer existing dependencies before adding a new package.",
        category: "dependencies",
        scope: "global",
      });
    } finally {
      db.close();
    }

    const proc = Bun.spawn(
      [BUN, "run", INDEX, "test-hook", "--task", "Install a date parsing package.", "--json"],
      {
        env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.wouldInject).toBe(true);
    expect(typeof parsed.block).toBe("string");
    expect(Array.isArray(parsed.preferences)).toBe(true);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);
