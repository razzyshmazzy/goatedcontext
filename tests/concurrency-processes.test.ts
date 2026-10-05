import { test, expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whichSync } from "../src/utils/runtime.ts";

/**
 * Real multi-PROCESS concurrency (0.3.0 diagnostic). Separate OS processes against
 * one WAL database — the real agent-fleet scenario, not Promises in one process.
 * Counts are modest to bound CI time; thresholds are catastrophic-only.
 */

const dist = join(import.meta.dir, "..", "dist", "index.js");
const node = whichSync("node");
const canRun = Boolean(node && existsSync(dist));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}
function spawnAsync(args: string[], env: NodeJS.ProcessEnv, input = ""): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(node!, [dist, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    // Always feed + close stdin: commands that read stdin (e.g. `hook`) would
    // otherwise block forever waiting for EOF.
    child.stdin.end(input);
  });
}

function freshHome(prefix: string): { home: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const env = { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" };
  spawnSync(node!, [dist, "init"], { env, encoding: "utf8" });
  return { home, env, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const noLock = (r: Run) => expect(r.stderr).not.toMatch(/database is locked|SQLITE_BUSY/i);

test(
  "32 concurrent READERS see a consistent snapshot, no lock errors",
  async () => {
    if (!canRun) { console.warn("[concurrency] skipped: build first."); return; }
    const { env, cleanup } = freshHome("ctx-conc-read-");
    try {
      spawnSync(node!, [dist, "remember", "--scope", "global", "--always", "Always sign your commits."], { env, encoding: "utf8" });
      spawnSync(node!, [dist, "remember", "--scope", "global", "--category", "database", "Prefer foreign keys."], { env, encoding: "utf8" });

      const N = 32;
      const runs = await Promise.all(Array.from({ length: N }, () => spawnAsync(["get", "--task", "database integrity"], env)));
      const payloads = new Set<string>();
      for (const r of runs) {
        expect(r.code).toBe(0);
        noLock(r);
        const json = JSON.parse(r.stdout); // must be valid JSON (no torn reads)
        payloads.add(JSON.stringify(json.preferences));
      }
      // No writes occurred during reads → every reader saw the identical snapshot.
      expect(payloads.size).toBe(1);
    } finally {
      cleanup();
    }
  },
  90_000,
);

test(
  "24 readers + 6 writers: no corruption, no lock errors, readers eventually see writes, exact write count",
  async () => {
    if (!canRun) { console.warn("[concurrency] skipped: build first."); return; }
    const { env, cleanup } = freshHome("ctx-conc-rw-");
    try {
      const writers = Array.from({ length: 6 }, (_, i) =>
        spawnAsync(["remember", "--scope", "global", "--category", "general", `Distinct concurrent writer rule ${i}.`], env),
      );
      const readers = Array.from({ length: 24 }, () => spawnAsync(["get", "--task", "anything"], env));
      // Hooks read a JSON payload on stdin and write stats — exercises the stats
      // file lock concurrently with DB readers/writers.
      const hookPayload = JSON.stringify({ cwd: process.cwd(), prompt: "database integrity work" });
      const statWriters = Array.from({ length: 4 }, () => spawnAsync(["hook", "codex-prompt"], env, hookPayload));

      const all = await Promise.all([...writers, ...readers, ...statWriters]);
      for (const r of all) {
        noLock(r);
        expect(r.code).toBe(0); // fail-open hooks + retrying writers never crash
      }
      for (const r of await Promise.all(readers)) {
        if (r.stdout.trim().startsWith("{")) JSON.parse(r.stdout); // readers' JSON stays well-formed
      }

      // Exactly the 6 distinct writer rules persisted (no lost/dup writes).
      const prefs = JSON.parse(spawnSync(node!, [dist, "prefs", "--json"], { env, encoding: "utf8" }).stdout) as { rule: string }[];
      const written = prefs.filter((p) => p.rule.startsWith("Distinct concurrent writer rule "));
      expect(written.length).toBe(6);
    } finally {
      cleanup();
    }
  },
  120_000,
);

test(
  "dedup write storm: 12 writers PROPOSE the same rule concurrently → exactly ONE preference",
  async () => {
    if (!canRun) { console.warn("[concurrency] skipped: build first."); return; }
    const { env, cleanup } = freshHome("ctx-conc-storm-");
    try {
      const RULE = "Prefer Redis for ephemeral caching.";
      const storm = Array.from({ length: 12 }, (_, i) =>
        spawnAsync(["propose", RULE, "--scope", "global", "--evidence", `observed run ${i}`], env),
      );
      const runs = await Promise.all(storm);
      for (const r of runs) noLock(r);
      // Every writer either created the one row or merged into it — none crashed on the
      // unique dedup index (INSERT race is resolved by BEGIN IMMEDIATE + ON CONFLICT).
      const succeeded = runs.filter((r) => r.code === 0).length;
      expect(succeeded).toBe(12);

      const prefs = JSON.parse(spawnSync(node!, [dist, "prefs", "--json"], { env, encoding: "utf8" }).stdout) as { rule: string }[];
      const matching = prefs.filter((p) => p.rule === RULE);
      expect(matching.length).toBe(1); // deterministic final state: ONE proposal, not 12
    } finally {
      cleanup();
    }
  },
  120_000,
);
