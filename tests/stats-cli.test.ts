import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { PreferenceService } from "../src/core/preferences/service.ts";
import { installClaude, repairClaude } from "../src/adapters/claude/installer.ts";

// End-to-end, multi-process coverage: each helper spawns a fresh `ctx` CLI so the
// concurrency tests exercise the real cross-process stats file lock, not just
// in-process Promise concurrency.

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const TIMEOUT = 90_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "ctx-stats-cli-"));
}

function seed(home: string, fn: (p: PreferenceService) => void): void {
  const db = openDatabase(resolvePaths({ CTX_HOME: home }));
  try {
    fn(new PreferenceService(db));
  } finally {
    db.close();
  }
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

async function readStats(home: string): Promise<Record<string, number | string | null | Record<string, number>>> {
  const r = await run(["stats", "--json"], home);
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout);
}

// A preference + prompt guaranteed to inject exactly ONE preference, so
// preferences_injected equals the number of injecting hooks.
const DEP_RULE = "Prefer existing dependencies before adding a new package.";
const INJECT_PROMPT = "Install a date parsing package dependency.";
const NOMATCH_PROMPT = "Rename the local variable x to count.";

function seedOneDepPref(home: string): void {
  seed(home, (p) => p.remember({ rule: DEP_RULE, category: "dependencies", scope: "global" }));
}

test(
  "zero state: `ctx stats` returns clean zeros",
  async () => {
    const home = freshHome();
    const j = await readStats(home);
    expect(j).toEqual({
      hook_runs: 0,
      context_injections: 0,
      no_match: 0,
      preferences_injected: 0,
      proposals_created: 0,
      last_injection_at: null,
      hook_runs_by_agent: {},
      context_injections_by_agent: {},
    });
    // Human output shows the never state.
    const human = await run(["stats"], home);
    expect(human.stdout).toContain("goatedcontext stats");
    expect(human.stdout).toContain("(never)");
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "hook injection updates hook_runs, context_injections, preferences_injected, last_injection_at",
  async () => {
    const home = freshHome();
    seedOneDepPref(home);
    const r = await hook(home, INJECT_PROMPT);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("<ctx-developer-context>");
    const j = await readStats(home);
    expect(j.hook_runs).toBe(1);
    expect(j.context_injections).toBe(1);
    expect(j.no_match).toBe(0);
    expect(j.preferences_injected).toBe(1);
    expect(typeof j.last_injection_at).toBe("string");
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "hook no-match updates hook_runs and no_match only",
  async () => {
    const home = freshHome();
    seedOneDepPref(home);
    const r = await hook(home, NOMATCH_PROMPT);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
    const j = await readStats(home);
    expect(j.hook_runs).toBe(1);
    expect(j.no_match).toBe(1);
    expect(j.context_injections).toBe(0);
    expect(j.preferences_injected).toBe(0);
    expect(j.last_injection_at).toBeNull();
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "propose increments proposals_created; an equivalent merge does not",
  async () => {
    const home = freshHome();
    await run(["init"], home);
    const a = await run(
      ["propose", "Prefer small focused pull requests.", "--category", "conventions", "--evidence", "seen once"],
      home,
    );
    expect(a.code).toBe(0);
    // Same subject + polarity -> merges evidence into the existing proposal.
    const b = await run(
      ["propose", "Prefer small focused pull requests.", "--category", "conventions", "--evidence", "seen twice"],
      home,
    );
    expect(b.code).toBe(0);
    expect(b.stdout.toLowerCase()).toContain("merged");
    const j = await readStats(home);
    expect(j.proposals_created).toBe(1); // only the first counted
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "concurrency: 20 injecting hooks record exact counts (no lost updates)",
  async () => {
    const home = freshHome();
    seedOneDepPref(home);
    const N = 20;
    const results = await Promise.all(Array.from({ length: N }, () => hook(home, INJECT_PROMPT)));
    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.stderr).not.toContain("database is locked");
    }
    const j = await readStats(home);
    expect(j.hook_runs).toBe(N);
    expect(j.context_injections).toBe(N);
    expect(j.no_match).toBe(0);
    expect(j.preferences_injected).toBe(N); // exactly one pref per injecting hook
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "concurrency: 20 no-match hooks record exactly 20 hook_runs / 20 no_match",
  async () => {
    const home = freshHome();
    seedOneDepPref(home);
    const N = 20;
    const results = await Promise.all(Array.from({ length: N }, () => hook(home, NOMATCH_PROMPT)));
    for (const r of results) expect(r.code).toBe(0);
    const j = await readStats(home);
    expect(j.hook_runs).toBe(N);
    expect(j.no_match).toBe(N);
    expect(j.context_injections).toBe(0);
    expect(j.preferences_injected).toBe(0);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "concurrency: mixed injecting + no-match hooks tally exactly",
  async () => {
    const home = freshHome();
    seedOneDepPref(home);
    const tasks: Promise<RunResult>[] = [];
    for (let i = 0; i < 10; i++) tasks.push(hook(home, INJECT_PROMPT));
    for (let i = 0; i < 10; i++) tasks.push(hook(home, NOMATCH_PROMPT));
    const results = await Promise.all(tasks);
    for (const r of results) expect(r.code).toBe(0);
    const j = await readStats(home);
    expect(j.hook_runs).toBe(20);
    expect(j.context_injections).toBe(10);
    expect(j.no_match).toBe(10);
    expect(j.preferences_injected).toBe(10);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "concurrency: distinct concurrent proposals each count once",
  async () => {
    const home = freshHome();
    await run(["init"], home);
    // Genuinely distinct subjects so none merge into another.
    const rules = [
      "Prefer composition over inheritance.",
      "Write integration tests for API endpoints.",
      "Use structured logging everywhere.",
      "Validate all external input at the boundary.",
      "Keep functions under fifty lines.",
      "Document public interfaces with examples.",
      "Cache expensive database reads.",
      "Roll out risky changes behind feature flags.",
    ];
    const results = await Promise.all(
      rules.map((rule, i) =>
        run(["propose", rule, "--category", "architecture", "--evidence", `e${i}`], home),
      ),
    );
    for (const r of results) expect(r.code).toBe(0);
    const j = await readStats(home);
    expect(j.proposals_created).toBe(rules.length);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "concurrency: reads during writes never crash and never see a corrupt store",
  async () => {
    const home = freshHome();
    seedOneDepPref(home);
    const writers = Array.from({ length: 15 }, () => hook(home, INJECT_PROMPT));
    const readers = Array.from({ length: 15 }, () => run(["stats", "--json"], home));
    const [w, r] = await Promise.all([Promise.all(writers), Promise.all(readers)]);
    for (const x of w) expect(x.code).toBe(0);
    for (const x of r) {
      expect(x.code).toBe(0);
      const parsed = JSON.parse(x.stdout); // must always be valid JSON
      expect(typeof parsed.hook_runs).toBe("number");
      expect(parsed.hook_runs).toBeGreaterThanOrEqual(0);
      expect(parsed.hook_runs).toBeLessThanOrEqual(15);
    }
    const final = await readStats(home);
    expect(final.hook_runs).toBe(15);
    expect(final.context_injections).toBe(15);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "hook still injects context even when the stats write fails (fail-open)",
  async () => {
    const home = freshHome();
    seedOneDepPref(home);
    // Make stats.json a directory so a stats write can never succeed.
    require("node:fs").mkdirSync(join(home, "stats.json"), { recursive: true });
    const r = await hook(home, INJECT_PROMPT);
    // Claude still gets the context; the hook exits cleanly.
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("<ctx-developer-context>");
    expect(r.stdout).toContain(DEP_RULE);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "`ctx stats --reset` clears counters (and --json reports it)",
  async () => {
    const home = freshHome();
    seedOneDepPref(home);
    await hook(home, INJECT_PROMPT);
    await hook(home, NOMATCH_PROMPT);
    let j = await readStats(home);
    expect(j.hook_runs).toBe(2);

    const reset = await run(["stats", "--reset"], home);
    expect(reset.code).toBe(0);
    expect(reset.stdout.toLowerCase()).toContain("reset");

    j = await readStats(home);
    expect(j.hook_runs).toBe(0);
    expect(j.context_injections).toBe(0);
    expect(j.no_match).toBe(0);
    expect(j.last_injection_at).toBeNull();

    const resetJson = await run(["stats", "--reset", "--json"], home);
    expect(resetJson.code).toBe(0);
    const parsed = JSON.parse(resetJson.stdout);
    expect(parsed.reset).toBe(true);
    expect(parsed.stats.hook_runs).toBe(0);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "`ctx stats --reset` leaves preferences untouched",
  async () => {
    const home = freshHome();
    seedOneDepPref(home);
    await hook(home, INJECT_PROMPT);
    await run(["stats", "--reset"], home);
    const prefs = await run(["prefs", "--json"], home);
    const list = JSON.parse(prefs.stdout);
    expect(list).toHaveLength(1);
    expect(list[0].rule).toBe(DEP_RULE);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "`ctx status` surfaces a subtle useful-injections line",
  async () => {
    const home = freshHome();
    seedOneDepPref(home);
    // Zero-state line first.
    const before = await run(["status"], home);
    expect(before.stdout).toContain("no useful injections yet");

    await hook(home, INJECT_PROMPT);
    const after = await run(["status"], home);
    expect(after.stdout).toContain("1 useful injection so far");

    // JSON summary carries the count too.
    const j = await run(["status", "--json"], home);
    expect(JSON.parse(j.stdout).usefulInjections).toBe(1);
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

// ---- Claude global instruction (install / repair idempotency) ---------------

test("install writes the stats instruction, and re-install/repair never duplicates it", () => {
  const claudeHome = mkdtempSync(join(tmpdir(), "ctx-stats-claude-"));
  installClaude({ claudeHome });
  let md = readFileSync(join(claudeHome, "CLAUDE.md"), "utf8");
  expect(md).toContain("ctx stats");
  expect(md).toContain("usage stats");
  // Idempotent re-install/repair keeps a single ctx block and a single mention.
  installClaude({ claudeHome });
  repairClaude({ claudeHome });
  md = readFileSync(join(claudeHome, "CLAUDE.md"), "utf8");
  expect(md.split("<!-- ctx:begin -->").length - 1).toBe(1);
  // Exactly one occurrence of the distinctive stats phrase.
  expect(md.split("`ctx stats`").length - 1).toBe(1);
  rmSync(claudeHome, { recursive: true, force: true });
});
