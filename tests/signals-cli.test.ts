import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whichSync } from "../src/utils/runtime.ts";

/**
 * Signal CLI surface (0.3.2): `ctx signal add` records one cheap signal and
 * `ctx signals --json` returns aggregated evidence an agent/test can inspect.
 * Runs against the built dist in an isolated CTX_HOME so the real store is untouched.
 */

const dist = join(import.meta.dir, "..", "dist", "index.js");
const node = whichSync("node");
const canRun = Boolean(node && existsSync(dist));

function run(env: NodeJS.ProcessEnv, args: string[]) {
  return spawnSync(node!, [dist, ...args], { env, encoding: "utf8" });
}

test("ctx signal add + ctx signals --json: record and aggregate non-authoritative evidence", () => {
  if (!canRun) { console.warn("[signals-cli] skipped: run `bun run build` first."); return; }
  const home = mkdtempSync(join(tmpdir(), "ctx-sig-"));
  const env = { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" } as NodeJS.ProcessEnv;
  try {
    expect(run(env, ["init"]).status).toBe(0);
    // Record outside a git repo (--no-repo) so the ledger has no repo linkage noise.
    expect(run(env, ["signal", "add", "--domain", "backend", "--choice", "Supabase", "--no-repo"]).status).toBe(0);
    expect(run(env, ["signal", "add", "--domain", "package-manager", "--choice", "bun", "--no-repo"]).status).toBe(0);

    const all = JSON.parse(run(env, ["signals", "--json"]).stdout) as { domain: string; choices: { choice: string; observations: number }[] }[];
    expect(all.map((d) => d.domain).sort()).toEqual(["backend", "package-manager"]);

    const backend = JSON.parse(run(env, ["signals", "--domain", "backend", "--json"]).stdout) as { domain: string; choices: { choice: string }[] }[];
    expect(backend).toHaveLength(1);
    expect(backend[0]!.domain).toBe("backend");
    expect(backend[0]!.choices[0]!.choice).toBe("supabase"); // normalized

    // Recording a signal must NOT create any preference (evidence, not instruction).
    const prefs = JSON.parse(run(env, ["prefs", "--json"]).stdout) as unknown[];
    expect(prefs).toHaveLength(0);

    // Raw rows are inspectable too.
    const raw = JSON.parse(run(env, ["signals", "--raw", "--json"]).stdout) as unknown[];
    expect(raw).toHaveLength(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
