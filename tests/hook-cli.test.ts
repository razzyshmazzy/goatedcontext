import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { PreferenceService } from "../src/core/preferences/service.ts";

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const TIMEOUT = 60_000;

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "ctx-hookcli-"));
}

function seed(home: string, fn: (p: PreferenceService) => void): void {
  const db = openDatabase(resolvePaths({ CTX_HOME: home }));
  try {
    fn(new PreferenceService(db));
  } finally {
    db.close();
  }
}

async function runHook(home: string, payload: unknown | string): Promise<{ code: number; out: string; err: string }> {
  const stdin = typeof payload === "string" ? payload : JSON.stringify(payload);
  const proc = Bun.spawn([BUN, "run", INDEX, "hook", "claude-prompt"], {
    env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    stdin: Buffer.from(stdin, "utf8"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out, err };
}

test(
  "hook injects a compact block for a relevant prompt",
  async () => {
    const home = freshHome();
    seed(home, (p) =>
      p.remember({
        rule: "Prefer existing dependencies before adding a new package.",
        category: "dependencies",
        scope: "global",
      }),
    );
    const r = await runHook(home, { cwd: process.cwd(), prompt: "Install a date parsing package." });
    expect(r.code).toBe(0);
    expect(r.out).toContain("<ctx-developer-context>");
    expect(r.out).toContain("Prefer existing dependencies before adding a new package.");
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "hook injects NOTHING for an irrelevant/trivial prompt",
  async () => {
    const home = freshHome();
    seed(home, (p) =>
      p.remember({
        rule: "Prefer relational constraints and database-enforced invariants.",
        category: "database",
        scope: "global",
      }),
    );
    const r = await runHook(home, { cwd: process.cwd(), prompt: "Rename the local variable x to count." });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("");
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "hook fails open on malformed input (exit 0, no output)",
  async () => {
    const home = freshHome();
    seed(home, () => {});
    const r = await runHook(home, "this is not json {{{");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("");
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "hook fails open when the ctx home is unusable",
  async () => {
    // Point CTX_HOME at a file path that cannot be a directory -> DB open fails.
    const bogus = join(freshHome(), "not-a-dir-file");
    Bun.spawnSync([BUN, "-e", `require('fs').writeFileSync(${JSON.stringify(bogus)}, 'x')`]);
    const proc = Bun.spawn([BUN, "run", INDEX, "hook", "claude-prompt"], {
      env: { ...process.env, CTX_HOME: bogus, CTX_SECRET_BACKEND: "file" },
      stdin: Buffer.from(JSON.stringify({ cwd: process.cwd(), prompt: "add a dependency" })),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0); // fail open — never breaks Claude
    expect(out.trim()).toBe("");
  },
  TIMEOUT,
);

test(
  "concurrent hook executions do not error or lock",
  async () => {
    const home = freshHome();
    seed(home, (p) => {
      for (let i = 0; i < 5; i++)
        p.remember({ rule: `Prefer dependency rule ${i} about packages.`, category: "dependencies", scope: "global" });
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => runHook(home, { cwd: process.cwd(), prompt: "add a new package dependency" })),
    );
    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.err).not.toContain("database is locked");
      expect(r.out).toContain("<ctx-developer-context>");
    }
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);

test(
  "prefs pending --json emits JSON (regression)",
  async () => {
    const home = freshHome();
    seed(home, (p) =>
      p.propose({
        rule: "Prefer functional core imperative shell.",
        category: "architecture",
        scope: "global",
        evidence: "seen",
      }),
    );
    const proc = Bun.spawn([BUN, "run", INDEX, "prefs", "pending", "--json"], {
      env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const parsed = JSON.parse(out); // must be valid JSON
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].rule).toContain("functional core");
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);
