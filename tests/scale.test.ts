import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestContext, type TestEnv } from "./helpers.ts";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { PreferenceService } from "../src/core/preferences/service.ts";
import type { CtxContext } from "../src/core/context.ts";

// These are stress/scale tests. They exist to catch pathological blow-ups (e.g. an
// accidental O(n^2) in retrieval), NOT to enforce tight performance numbers.
// Thresholds are therefore deliberately generous — many times the time a normal
// machine needs — so they never flake on a busy CI runner. Actual timings are
// logged for visibility.

const TIMEOUT = 120_000;

const TOPICS = [
  "database", "testing", "architecture", "dependencies",
  "formatting", "infrastructure", "security", "error-handling",
];

/** Insert `n` varied global preferences using the real service path. */
function seedPreferences(ctx: CtxContext, n: number): number {
  const start = performance.now();
  for (let i = 0; i < n; i++) {
    ctx.preferences.remember({
      rule: `Rule ${i}: prefer approach ${i % 97} for ${TOPICS[i % TOPICS.length]} concerns in module ${i % 250}.`,
      category: TOPICS[i % TOPICS.length]!,
      scope: "global",
    });
  }
  return performance.now() - start;
}

function ms(n: number): string {
  return `${Math.round(n)}ms`;
}

// ---- large preference counts ------------------------------------------------

test(
  "retrieval stays fast with 1,000 preferences",
  () => {
    const t: TestEnv = makeTestContext();
    try {
      const insertMs = seedPreferences(t.ctx, 1_000);
      const start = performance.now();
      const result = t.ctx.retrieval.retrieve({
        cwd: process.cwd(),
        task: "design the database schema and add migrations",
        track: false,
      });
      const retrieveMs = performance.now() - start;
      console.log(`[scale] 1k prefs: insert=${ms(insertMs)} retrieve=${ms(retrieveMs)}`);

      expect(t.ctx.preferences.list()).toHaveLength(1_000);
      expect(result.preferences.length).toBeGreaterThan(0);
      expect(result.preferences.length).toBeLessThanOrEqual(15); // limit respected
      expect(retrieveMs).toBeLessThan(3_000); // generous
    } finally {
      t.cleanup();
    }
  },
  TIMEOUT,
);

test(
  "retrieval stays reasonable with 10,000 preferences",
  () => {
    const t: TestEnv = makeTestContext();
    try {
      const insertMs = seedPreferences(t.ctx, 10_000);
      const start = performance.now();
      const result = t.ctx.retrieval.retrieve({
        cwd: process.cwd(),
        task: "improve error handling and add retry with fallback",
        track: false,
      });
      const retrieveMs = performance.now() - start;
      console.log(`[scale] 10k prefs: insert=${ms(insertMs)} retrieve=${ms(retrieveMs)}`);

      expect(t.ctx.preferences.list()).toHaveLength(10_000);
      expect(result.preferences.length).toBeLessThanOrEqual(15);
      // A single retrieval over 10k rows should be well under this on any machine.
      expect(retrieveMs).toBeLessThan(15_000);
    } finally {
      t.cleanup();
    }
  },
  TIMEOUT,
);

// ---- large evidence counts --------------------------------------------------

test(
  "a preference with thousands of evidence rows reads efficiently",
  () => {
    const t: TestEnv = makeTestContext();
    try {
      const pref = t.ctx.preferences.remember({
        rule: "Prefer parameterized SQL queries.",
        category: "security",
        scope: "global",
      });
      const N = 3_000;
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        t.ctx.preferences.addEvidence(pref.id, {
          source: "agent",
          repoId: null,
          text: `distinct observation number ${i} supporting the rule`,
        });
      }
      const insertMs = performance.now() - start;

      const countStart = performance.now();
      const count = t.ctx.preferences.evidenceCount(pref.id);
      const countMs = performance.now() - countStart;

      const listStart = performance.now();
      const rows = t.ctx.preferences.evidenceFor(pref.id);
      const listMs = performance.now() - listStart;
      console.log(`[scale] ${N} evidence: insert=${ms(insertMs)} count=${ms(countMs)} list=${ms(listMs)}`);

      expect(count).toBe(N + 1); // N added + the 1 from remember()
      expect(rows).toHaveLength(N + 1);
      expect(countMs).toBeLessThan(1_000);
      expect(listMs).toBeLessThan(3_000);
    } finally {
      t.cleanup();
    }
  },
  TIMEOUT,
);

// ---- large prompt / task text -----------------------------------------------

test(
  "retrieval handles a very large task string without blowing up",
  () => {
    const t: TestEnv = makeTestContext();
    try {
      seedPreferences(t.ctx, 500);
      // ~100k characters of realistic-ish prose plus the real signal at the end.
      const filler = "the quick brown fox refactors the module and reviews the code ".repeat(1_600);
      const task = filler + " design the database schema with proper migrations and indexes";
      expect(task.length).toBeGreaterThan(90_000);

      const start = performance.now();
      const result = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task, track: false });
      const retrieveMs = performance.now() - start;
      console.log(`[scale] large task (${task.length} chars): retrieve=${ms(retrieveMs)}`);

      expect(result.preferences.length).toBeLessThanOrEqual(15);
      expect(retrieveMs).toBeLessThan(5_000);
    } finally {
      t.cleanup();
    }
  },
  TIMEOUT,
);

// ---- concurrency (real cross-process) ---------------------------------------

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");

function ctxRun(home: string, args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn([BUN, "run", INDEX, ...args], {
    env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
  });
  return (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  })();
}

function hookRun(home: string, prompt: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn([BUN, "run", INDEX, "hook", "claude-prompt"], {
    env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    stdin: Buffer.from(JSON.stringify({ cwd: process.cwd(), prompt }), "utf8"),
    stdout: "pipe",
    stderr: "pipe",
  });
  return (async () => {
    const stderr = await new Response(proc.stderr).text();
    return { code: await proc.exited, stderr };
  })();
}

test(
  "many concurrent hook reads never lock or error",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-scale-hook-"));
    const db = openDatabase(resolvePaths({ CTX_HOME: home }));
    try {
      const p = new PreferenceService(db);
      for (let i = 0; i < 20; i++) {
        p.remember({
          rule: `Prefer dependency practice ${i} when installing packages.`,
          category: "dependencies",
          scope: "global",
        });
      }
    } finally {
      db.close();
    }

    const N = 24;
    const start = performance.now();
    const results = await Promise.all(
      Array.from({ length: N }, () => hookRun(home, "install a new package dependency")),
    );
    console.log(`[scale] ${N} concurrent hook reads: ${ms(performance.now() - start)}`);

    for (const r of results) {
      expect(r.code).toBe(0); // hook always fails open / succeeds
      expect(r.stderr).not.toContain("database is locked");
    }
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "many concurrent distinct proposal writes all persist without loss",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-scale-write-"));
    await ctxRun(home, ["init"]);

    // Genuinely distinct subjects, so propose()'s near-duplicate merge does NOT
    // collapse them — this test is about write concurrency, not dedup.
    const SUBJECTS = [
      "redis", "kafka", "postgres", "graphql", "webpack", "eslint", "docker", "kubernetes",
      "terraform", "grpc", "rabbitmq", "elasticsearch", "prometheus", "nginx", "vitest", "playwright",
    ];
    const N = SUBJECTS.length;
    const start = performance.now();
    const results = await Promise.all(
      SUBJECTS.map((subject, i) =>
        ctxRun(home, [
          "propose",
          `Prefer ${subject} for the ${subject} layer.`,
          "--scope", "global",
          "--category", "infrastructure",
          "--evidence", `agent ${i} observed ${subject} usage`,
        ]),
      ),
    );
    console.log(`[scale] ${N} concurrent proposal writes: ${ms(performance.now() - start)}`);

    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.stderr).not.toContain("database is locked");
    }

    // Every distinct proposal persisted exactly once — no lost writes, no dupes.
    const db = openDatabase(resolvePaths({ CTX_HOME: home }));
    try {
      const n = db
        .query<{ n: number }, []>("SELECT COUNT(*) n FROM preferences WHERE status = 'proposed'")
        .get()!.n;
      expect(n).toBe(N);
    } finally {
      db.close();
    }
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);
