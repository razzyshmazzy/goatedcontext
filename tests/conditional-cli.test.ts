import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { PreferenceService } from "../src/core/preferences/service.ts";

// End-to-end CLI coverage for conditional preferences, using spawned `ctx`
// processes so validation/hook/concurrency paths run exactly as in production.

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const TIMEOUT = 90_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "ctx-cond-cli-"));
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
    return { code: await proc.exited, stdout, stderr };
  })();
}

function hook(home: string, prompt: string): Promise<RunResult> {
  return run(["hook", "claude-prompt"], home, JSON.stringify({ cwd: home, prompt }));
}

// ---- creation + inference ---------------------------------------------------

test(
  "--when creates a conditional preference (applicability inferred)",
  async () => {
    const home = freshHome();
    const r = await run(["remember", "--scope", "global", "--when", "language=typescript", "Prefer strict TypeScript."], home);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("applicability=conditional");
    expect(r.stdout).toContain("condition=[language=typescript]");

    const list = JSON.parse((await run(["prefs", "--json"], home)).stdout);
    expect(list).toHaveLength(1);
    expect(list[0].applicability).toBe("conditional");
    expect(list[0].condition).toEqual({ language: "typescript" });
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "repeated --when canonicalizes to a logical ALL",
  async () => {
    const home = freshHome();
    const r = await run(
      [
        "remember",
        "--scope",
        "global",
        "--when",
        "language=typescript",
        "--when",
        "file=src/**/*.ts",
        "Prefer explicit return types for exported functions.",
      ],
      home,
    );
    expect(r.code).toBe(0);
    const list = JSON.parse((await run(["prefs", "--json"], home)).stdout);
    expect(list[0].condition).toEqual({
      all: [{ file: "src/**/*.ts" }, { language: "typescript" }],
    });
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "propose supports --when the same way",
  async () => {
    const home = freshHome();
    const r = await run(
      ["propose", "Prefer foreign keys.", "--scope", "global", "--when", "domain=database", "--evidence", "seen in review"],
      home,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("applicability=conditional");
    const pending = JSON.parse((await run(["prefs", "pending", "--json"], home)).stdout);
    expect(pending[0].condition).toEqual({ domain: "database" });
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

// ---- flag conflicts (no write on failure) -----------------------------------

async function expectRejectedNoWrite(home: string, args: string[], needle: string) {
  const r = await run(args, home);
  expect(r.code).not.toBe(0);
  expect(r.stderr.toLowerCase()).toContain(needle);
  const list = JSON.parse((await run(["prefs", "--json"], home)).stdout);
  expect(list).toHaveLength(0); // nothing persisted
}

test(
  "--always + --when is rejected with no write",
  async () => {
    const home = freshHome();
    await expectRejectedNoWrite(
      home,
      ["remember", "--scope", "global", "--always", "--when", "language=typescript", "X."],
      "conflicting",
    );
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "--applicability relevant + --when is rejected with no write",
  async () => {
    const home = freshHome();
    await expectRejectedNoWrite(
      home,
      ["remember", "--scope", "global", "--applicability", "relevant", "--when", "language=typescript", "X."],
      "conflicting",
    );
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "--applicability conditional with no --when is rejected with no write",
  async () => {
    const home = freshHome();
    await expectRejectedNoWrite(
      home,
      ["remember", "--scope", "global", "--applicability", "conditional", "X."],
      "requires",
    );
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "invalid --when key and empty/invalid value are rejected with no write",
  async () => {
    const home = freshHome();
    await expectRejectedNoWrite(
      home,
      ["remember", "--scope", "global", "--when", "branch=main", "X."],
      "key",
    );
    await expectRejectedNoWrite(
      home,
      ["remember", "--scope", "global", "--when", "language=cobol", "X."],
      "language",
    );
    await expectRejectedNoWrite(
      home,
      ["remember", "--scope", "global", "--when", "language=", "X."],
      "value",
    );
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

// ---- inspection surfaces ----------------------------------------------------

test(
  "why and prefs render the condition without raw JSON",
  async () => {
    const home = freshHome();
    await run(
      ["remember", "--scope", "global", "--when", "language=typescript", "--when", "file=src/**/*.ts", "Prefer explicit return types."],
      home,
    );
    const prefsJson = JSON.parse((await run(["prefs", "--json"], home)).stdout);
    const id = prefsJson[0].id as string;

    const prefs = await run(["prefs"], home);
    expect(prefs.stdout).toContain("conditional");
    expect(prefs.stdout).toContain("all(");

    const why = await run(["why", id], home);
    expect(why.stdout).toContain("applicability: conditional");
    expect(why.stdout).toContain("ALL");
    expect(why.stdout).toContain("language = typescript");
    expect(why.stdout).toContain("file = src/**/*.ts");
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

// ---- test-hook (the main debugging surface) --------------------------------

test(
  "test-hook explains a matched language conditional with --file, and a miss without it",
  async () => {
    const home = freshHome();
    await run(["remember", "--scope", "global", "--when", "language=typescript", "Prefer strict TypeScript."], home);

    // With a .ts file → language=typescript → injected.
    const hit = JSON.parse(
      (await run(["test-hook", "--task", "refactor this", "--file", "src/app.ts", "--json"], home)).stdout,
    );
    expect(hit.wouldInject).toBe(true);
    expect(hit.runtimeContext.languages).toContain("typescript");
    expect(hit.preferences.map((p: { rule: string }) => p.rule)).toContain("Prefer strict TypeScript.");

    // With a .py file → not injected; evaluation explains why.
    const pyMiss = JSON.parse(
      (await run(["test-hook", "--task", "refactor this", "--file", "src/app.py", "--json"], home)).stdout,
    );
    expect(pyMiss.wouldInject).toBe(false);
    const ev = pyMiss.conditionalEvaluations.find((e: { rule: string }) => e.rule === "Prefer strict TypeScript.");
    expect(ev.matched).toBe(false);

    // No file at all → missing language context → not injected.
    const noFile = JSON.parse((await run(["test-hook", "--task", "refactor this", "--json"], home)).stdout);
    expect(noFile.wouldInject).toBe(false);

    // Human output shows Runtime context + a Not matched section.
    const human = await run(["test-hook", "--task", "refactor this", "--file", "src/app.py"], home);
    expect(human.stdout).toContain("Runtime context");
    expect(human.stdout).toContain("Not matched");
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

// ---- export / import round trip over the CLI --------------------------------

test(
  "conditional preferences survive an export → import round trip (idempotent)",
  async () => {
    const home = freshHome();
    await run(["remember", "--scope", "global", "--when", "domain=database", "Prefer foreign keys."], home);
    const bundleFile = join(home, "bundle.json");
    await run(["export", "--out", bundleFile], home);

    const dest = freshHome();
    const imp1 = JSON.parse((await run(["import", bundleFile, "--json"], dest)).stdout);
    expect(imp1.imported).toBe(1);
    const imp2 = JSON.parse((await run(["import", bundleFile, "--json"], dest)).stdout);
    expect(imp2.imported).toBe(0); // idempotent

    const list = JSON.parse((await run(["prefs", "--json"], dest)).stdout);
    expect(list).toHaveLength(1);
    expect(list[0].condition).toEqual({ domain: "database" });
    rmSync(home, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  },
  TIMEOUT,
);

// ---- concurrency ------------------------------------------------------------

test(
  "20 concurrent MATCHING hooks inject the conditional every time; stats exact; no locks",
  async () => {
    const home = freshHome();
    // Seed a domain conditional directly (the hook can derive domain from the prompt).
    const db = openDatabase(resolvePaths({ CTX_HOME: home }));
    try {
      new PreferenceService(db).remember({
        rule: "Prefer foreign keys for integrity.",
        scope: "global",
        condition: { domain: "database" },
      });
    } finally {
      db.close();
    }

    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => hook(home, "design a database schema with migrations and indexes")),
    );
    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.stderr).not.toMatch(/database is locked/i);
      expect(r.stdout).toContain("Prefer foreign keys for integrity.");
      expect(r.stdout.split("Prefer foreign keys for integrity.").length - 1).toBe(1); // no dupes
    }

    const stats = JSON.parse((await run(["stats", "--json"], home)).stdout);
    expect(stats.hook_runs).toBe(N);
    expect(stats.context_injections).toBe(N);
    expect(stats.no_match).toBe(0);
    expect(stats.preferences_injected).toBe(N);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "20 concurrent NON-matching hooks inject nothing; stats exact; no locks",
  async () => {
    const home = freshHome();
    const db = openDatabase(resolvePaths({ CTX_HOME: home }));
    try {
      new PreferenceService(db).remember({
        rule: "Prefer foreign keys for integrity.",
        scope: "global",
        condition: { domain: "database" },
      });
    } finally {
      db.close();
    }

    const N = 20;
    const results = await Promise.all(Array.from({ length: N }, () => hook(home, "say hello politely")));
    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.stderr).not.toMatch(/database is locked/i);
      expect(r.stdout).not.toContain("Prefer foreign keys");
    }

    const stats = JSON.parse((await run(["stats", "--json"], home)).stdout);
    expect(stats.hook_runs).toBe(N);
    expect(stats.context_injections).toBe(0);
    expect(stats.no_match).toBe(N);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "mixed concurrent matching/non-matching hooks tally exactly",
  async () => {
    const home = freshHome();
    const db = openDatabase(resolvePaths({ CTX_HOME: home }));
    try {
      new PreferenceService(db).remember({
        rule: "Prefer foreign keys for integrity.",
        scope: "global",
        condition: { domain: "database" },
      });
    } finally {
      db.close();
    }

    const tasks: Promise<RunResult>[] = [];
    for (let i = 0; i < 10; i++) tasks.push(hook(home, "design a database schema")); // match → 1 pref
    for (let i = 0; i < 10; i++) tasks.push(hook(home, "greet the user")); // no match → 0
    const results = await Promise.all(tasks);
    for (const r of results) expect(r.code).toBe(0);

    const stats = JSON.parse((await run(["stats", "--json"], home)).stdout);
    expect(stats.hook_runs).toBe(20);
    expect(stats.context_injections).toBe(10);
    expect(stats.no_match).toBe(10);
    expect(stats.preferences_injected).toBe(10);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);
