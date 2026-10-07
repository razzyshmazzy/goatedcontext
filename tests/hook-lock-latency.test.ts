import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { CtxContext } from "../src/core/context.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { ensureHome } from "../src/storage/config.ts";

/**
 * Hook DB-lock latency (Wave 2). A locked DB must NOT make the latency-sensitive prompt
 * hook consume its full ~10s deadline. The hook opens its context with a short
 * busy_timeout and fails open; normal CLI writes keep the durable 10s wait.
 */

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");

function home(): string {
  return mkdtempSync(join(tmpdir(), "ctx-hooklock-"));
}
function run(args: string[], h: string, stdin?: string) {
  const proc = Bun.spawn([BUN, "run", INDEX, ...args], {
    cwd: h,
    env: { ...process.env, CTX_HOME: h, CTX_SECRET_BACKEND: "file" },
    stdin: stdin != null ? Buffer.from(stdin, "utf8") : undefined,
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

function busyTimeoutOf(db: ReturnType<typeof openDatabase>): number {
  const row = db.query<Record<string, number>, []>("PRAGMA busy_timeout").get();
  return row ? Number(Object.values(row)[0]) : -1;
}

// ── the connection-level bound (deterministic) ────────────────────────────────

test("a short busy_timeout bounds a write-lock wait far below the 10s default", () => {
  const h = home();
  try {
    const paths = resolvePaths({ CTX_HOME: h });
    ensureHome(paths);
    const holder = openDatabase(paths); // default 10s
    holder.exec("BEGIN IMMEDIATE"); // hold the write lock
    holder.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (9991, 'x', 't')").run();

    const hookConn = openDatabase(paths, { busyTimeoutMs: 250 });
    const t0 = performance.now();
    let busied = false;
    try {
      hookConn.exec("BEGIN IMMEDIATE"); // contends with the held write lock
      hookConn.exec("COMMIT");
    } catch {
      busied = true; // SQLITE_BUSY after ~250ms
    }
    const elapsed = performance.now() - t0;
    expect(busied).toBe(true);
    expect(elapsed).toBeLessThan(3000); // bounded — nowhere near the 10s default

    holder.exec("ROLLBACK");
    holder.close();
    hookConn.close();
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

// ── normal CLI durability is untouched (§15) ──────────────────────────────────

test("hook context uses the short busy_timeout; normal context keeps the 10s default", () => {
  const h = home();
  try {
    const def = CtxContext.open({ CTX_HOME: h, CTX_SECRET_BACKEND: "file" } as NodeJS.ProcessEnv);
    expect(busyTimeoutOf(def.db)).toBe(10000); // durable default for remember/propose/env set
    def.close();

    const hook = CtxContext.open({ CTX_HOME: h, CTX_SECRET_BACKEND: "file" } as NodeJS.ProcessEnv, {
      busyTimeoutMs: 250,
    });
    expect(busyTimeoutOf(hook.db)).toBe(250);
    hook.close();
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

// ── hook correctness + fail-open (§14, §20) ───────────────────────────────────

test("hook still injects an always-on preference for a normal prompt (correctness)", async () => {
  const h = home();
  try {
    expect((await run(["remember", "Always use Bun for development.", "--always"], h)).code).toBe(0);
    const payload = JSON.stringify({ cwd: h, prompt: "help me build a feature" });
    const res = await run(["hook", "claude-prompt"], h, payload);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Bun"); // the always rule was injected
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
}, 30_000);

test("hook FAILS OPEN on a corrupt DB: exit 0, no output, bounded time", async () => {
  const h = home();
  try {
    // Initialize a valid store first, then corrupt the DB file.
    expect((await run(["remember", "Always use Bun.", "--always"], h)).code).toBe(0);
    writeFileSync(join(h, "ctx.db"), "NOT A SQLITE FILE".repeat(50));

    const payload = JSON.stringify({ cwd: h, prompt: "do something" });
    const t0 = performance.now();
    const res = await run(["hook", "claude-prompt"], h, payload);
    const elapsed = performance.now() - t0;
    expect(res.code).toBe(0); // fail open — never blocks the agent
    expect(res.stdout.trim()).toBe(""); // no (and certainly no partial) context
    expect(elapsed).toBeLessThan(10_000); // bounded, not a 10s stall
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
}, 30_000);
