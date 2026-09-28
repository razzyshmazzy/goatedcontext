import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whichSync } from "../src/utils/runtime.ts";

// The published CLI must run on plain Node (no Bun), using the better-sqlite3
// backend. This spawns the BUILT bundle with the real `node` binary and drives it
// through the core commands. It self-skips if the bundle hasn't been built or Node
// is unavailable; CI builds before testing so it runs there.

const DIST = join(import.meta.dir, "..", "dist", "index.js");
const NODE = whichSync("node");
const TIMEOUT = 60_000;

function runNode(
  home: string,
  args: string[],
  input?: string,
): { code: number | null; stdout: string; stderr: string } {
  const res = spawnSync(NODE!, [DIST, ...args], {
    env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    input,
    encoding: "utf8",
    windowsHide: true,
  });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test(
  "the built CLI runs under Node with the better-sqlite3 backend",
  () => {
    if (!NODE || !existsSync(DIST)) {
      console.warn("[node-runtime] skipped: `node` or dist/index.js not available (run `bun run build`).");
      return;
    }
    const home = mkdtempSync(join(tmpdir(), "ctx-node-runtime-"));
    try {
      // version
      expect(runNode(home, ["--version"]).stdout).toContain("0.2.0");

      // init creates the SQLite database via better-sqlite3
      const init = runNode(home, ["init"]);
      expect(init.code).toBe(0);
      expect(existsSync(join(home, "ctx.db"))).toBe(true);

      // a real write path
      const remembered = runNode(home, [
        "remember",
        "--scope",
        "global",
        "--category",
        "dependencies",
        "Use pnpm to install packages.",
      ]);
      expect(remembered.code).toBe(0);

      // the proactive hook reads stdin JSON and injects the block
      const hook = runNode(
        home,
        ["hook", "claude-prompt"],
        JSON.stringify({ cwd: process.cwd(), prompt: "install a package dependency with pnpm" }),
      );
      expect(hook.code).toBe(0);
      expect(hook.stdout).toContain("<ctx-developer-context>");
      expect(hook.stdout).toContain("pnpm");

      // doctor confirms the Node backend is actually in use
      const doctor = runNode(home, ["doctor", "--json"]);
      const report = JSON.parse(doctor.stdout) as { checks: { id: string; detail?: string }[] };
      const runtime = report.checks.find((c) => c.id === "runtime");
      expect(runtime?.detail).toContain("better-sqlite3");
      expect(runtime?.detail).toContain("Node");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);
