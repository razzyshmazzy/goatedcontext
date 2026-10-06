import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Phase 7 (0.4.0), spec §19: a DETERMINISTIC forced-lock contention test. Process A
// holds a BEGIN IMMEDIATE write lock for a controlled duration; process B runs a real
// `ctx agent signal add`. We drive the outcome deterministically by setting a small
// CTX_BUSY_TIMEOUT_MS (so the test is fast and stable cross-platform, not a 10s wait):
//   Case 1 — lock released WITHIN the timeout  → B succeeds.
//   Case 2 — lock held BEYOND the timeout      → B exits cleanly with a bounded, actionable
//            error; no corruption; no partial state; no infinite wait.

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const HOLDER = join(import.meta.dir, "support", "lock-holder.ts");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

function runCtx(args: string[], env: Record<string, string>): Run {
  const start = performance.now();
  try {
    const stdout = execFileSync(BUN, ["run", INDEX, ...args], { env, encoding: "utf8" });
    return { code: 0, stdout, stderr: "", ms: performance.now() - start };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      ms: performance.now() - start,
    };
  }
}

/** Spawn the holder and wait until it has acquired the write lock (ready file appears). */
async function startHolder(home: string, holdMs: number): Promise<{ readyFile: string; proc: ReturnType<typeof Bun.spawn> }> {
  const readyFile = join(home, ".lock-ready");
  const proc = Bun.spawn([BUN, "run", HOLDER, String(holdMs)], {
    env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file", CTX_LOCK_READY_FILE: readyFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = performance.now() + 5000;
  while (!existsSync(readyFile)) {
    if (performance.now() > deadline) throw new Error("holder never acquired the lock");
    await Bun.sleep(10);
  }
  return { readyFile, proc };
}

test(
  "Case 1: lock released within busy_timeout → the signal write succeeds",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-lock1-"));
    const env = { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file", CTX_BUSY_TIMEOUT_MS: "5000" } as Record<string, string>;
    try {
      // Initialize the schema first so the holder opens an already-migrated DB.
      runCtx(["domains", "--json"], env);
      const { proc } = await startHolder(home, 800); // held < the contender's 5s timeout
      const r = runCtx(["agent", "signal", "add", "--origin", "user", "--domain", "testing", "--choice", "vitest"], env);
      await proc.exited;
      expect(r.code).toBe(0); // B waited through the brief lock and committed
      const signals = JSON.parse(runCtx(["signals", "--raw", "--json"], env).stdout);
      expect(signals.some((s: { choiceRaw?: string; choice?: string }) => (s.choiceRaw ?? s.choice) === "vitest")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  30_000,
);

test(
  "Case 2: lock held beyond busy_timeout → B fails cleanly, bounded, no corruption/partial state",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-lock2-"));
    const env = { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file", CTX_BUSY_TIMEOUT_MS: "200" } as Record<string, string>;
    try {
      runCtx(["domains", "--json"], env);
      const { proc } = await startHolder(home, 6000); // held FAR beyond the 200ms timeout + retries
      const r = runCtx(["agent", "signal", "add", "--origin", "user", "--domain", "testing", "--choice", "jest"], env);
      // Bounded: the contender gives up (retries exhausted) well before the holder releases.
      expect(r.code).not.toBe(0);
      expect(r.ms).toBeLessThan(8000); // no infinite wait
      expect((r.stderr + r.stdout).toLowerCase()).toMatch(/lock|busy/);
      await proc.exited; // holder releases cleanly

      // No corruption and no partial state: the DB is readable and the failed write left no row.
      const signals = JSON.parse(runCtx(["signals", "--raw", "--json"], env).stdout);
      expect(signals.some((s: { choiceRaw?: string; choice?: string }) => (s.choiceRaw ?? s.choice) === "jest")).toBe(false);
      // The store still works for a fresh write after the contention resolved.
      const ok = runCtx(["agent", "signal", "add", "--origin", "user", "--domain", "testing", "--choice", "bun-test"], env);
      expect(ok.code).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  30_000,
);
