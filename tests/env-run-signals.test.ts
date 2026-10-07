import { test, expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitCodeFromChild } from "../src/utils/runtime.ts";

/**
 * `ctx env run` process-lifecycle regressions (Wave 2):
 *   - a child killed by a signal must NOT report success (old `status ?? 0` bug)
 *   - signals received by ctx are forwarded to the child; no orphan survives
 */

const POSIX = process.platform !== "win32";
const bun = process.execPath; // running under `bun test`
const srcIndex = join(import.meta.dir, "..", "src", "index.ts");

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "ctx-sig-"));
}
function cli(args: string[], home: string) {
  return spawnSync(bun, [srcIndex, ...args], {
    encoding: "utf8",
    env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
  });
}

// ── exit-code mapping (cross-platform unit) ───────────────────────────────────

test("exitCodeFromChild maps numeric exits, signals, and the no-info case", () => {
  expect(exitCodeFromChild(7, null)).toBe(7); // normal exit unchanged
  expect(exitCodeFromChild(0, null)).toBe(0);
  // Neither code nor signal: fail CLOSED (nonzero). Not reachable on the env-run path
  // (exit always sets exactly one), but a no-information exit must never mean success.
  expect(exitCodeFromChild(null, null)).toBe(1);
  // Signal → 128 + number (these numbers are defined on every platform Node targets).
  expect(exitCodeFromChild(null, "SIGTERM")).toBe(143);
  expect(exitCodeFromChild(null, "SIGKILL")).toBe(137);
  // SIGPIPE is POSIX-only; assert 141 only where the runtime defines it.
  if ((osConstants.signals as Record<string, number | undefined>).SIGPIPE) {
    expect(exitCodeFromChild(null, "SIGPIPE")).toBe(141);
  }
  // A signal death is NEVER success.
  expect(exitCodeFromChild(null, "SIGTERM")).not.toBe(0);
});

// ── end-to-end exit code (cross-platform) ─────────────────────────────────────

test("env run propagates a numeric child exit code (exit 7 → 7)", () => {
  const home = makeHome();
  try {
    expect(cli(["env", "add", "sig"], home).status).toBe(0);
    const res = cli(["env", "run", "sig", "--exec", "node", "-e", "process.exit(7)"], home);
    expect(res.status).toBe(7);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

// ── POSIX signal-death exit codes ─────────────────────────────────────────────

test.if(POSIX)("env run reports 128+signal for a signal-killed child", () => {
  const home = makeHome();
  try {
    cli(["env", "add", "sig"], home);
    expect(cli(["env", "run", "sig", "--", "sh", "-c", "kill -TERM $$"], home).status).toBe(143);
    expect(cli(["env", "run", "sig", "--", "sh", "-c", "kill -KILL $$"], home).status).toBe(137);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

// ── POSIX signal forwarding / no orphan ───────────────────────────────────────

test.if(POSIX)("ctx forwards SIGTERM to the child; the grandchild does not orphan", async () => {
  const home = makeHome();
  const pidFile = join(home, "grandchild.pid");
  try {
    cli(["env", "add", "sig"], home);
    // A long-lived grandchild that records its PID so we can check it later.
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`;
    const ctxChild = spawn(bun, [srcIndex, "env", "run", "sig", "--", "node", "-e", script], {
      env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
      stdio: "ignore",
    });

    // Wait for the grandchild to come up and write its PID.
    const start = Date.now();
    while (!existsSync(pidFile) && Date.now() - start < 10_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(pidFile)).toBe(true);
    const grandPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);

    // Signal ctx; it must forward to the child and exit.
    const exited = new Promise<void>((resolve) => ctxChild.on("exit", () => resolve()));
    ctxChild.kill("SIGTERM");
    await exited;

    // Give the OS a brief moment to reap the grandchild, then assert it is gone.
    await new Promise((r) => setTimeout(r, 300));
    let alive = true;
    try {
      process.kill(grandPid, 0); // throws ESRCH if the process no longer exists
    } catch {
      alive = false;
    }
    expect(alive).toBe(false); // no orphan
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
