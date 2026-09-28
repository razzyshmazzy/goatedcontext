import { test, expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whichSync } from "../src/utils/runtime.ts";
import { openDb } from "../src/storage/sqlite/driver.ts";

// Distribution hardening for 0.2.2: the published package must have NO native
// dependency and must run on plain Node via the built-in `node:sqlite`.

const ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

test("package.json declares no native SQLite dependency", () => {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
  expect(deps["better-sqlite3"]).toBeUndefined();
  expect(deps["prebuild-install"]).toBeUndefined();
  expect(deps["node-gyp"]).toBeUndefined();
  // No trustedDependencies allow-list is needed once the native addon is gone.
  expect(pkg.trustedDependencies).toBeUndefined();
});

test("runtime dependencies are only the two intentional ones", () => {
  expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["commander", "zod"]);
});

test("engines.node baseline is the node:sqlite LTS baseline (>=22.13)", () => {
  expect(pkg.engines?.node).toBe(">=22.13.0");
});

test("the source never statically imports a native SQLite binding", () => {
  const driver = readFileSync(join(ROOT, "src", "storage", "sqlite", "driver.ts"), "utf8");
  expect(driver).not.toContain("better-sqlite3");
  expect(driver).toContain("node:sqlite");
  expect(driver).toContain("bun:sqlite");
});

// End-to-end: drive the BUILT bundle under real Node and confirm the full DB
// stack (migrations, WAL, write/read) works with node:sqlite, no native build.
test("built CLI exercises node:sqlite end-to-end under Node", () => {
  const dist = join(ROOT, "dist", "index.js");
  const node = whichSync("node");
  if (!node || !existsSync(dist)) {
    console.warn("[distribution] skipped: run `bun run build` first.");
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "ctx-dist-"));
  try {
    const env = { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" };
    const run = (args: string[], input?: string) =>
      spawnSync(node, [dist, ...args], { encoding: "utf8", env, input });

    const init = run(["init"]);
    expect(init.status).toBe(0);
    expect(init.stderr).not.toContain("ExperimentalWarning");
    expect(existsSync(join(home, "ctx.db"))).toBe(true);
    // WAL is persisted in the DB header (the -wal file itself is checkpointed
    // away on clean close, so we reopen and read the journal mode instead). Open
    // read-write here: a read-only reopen of a WAL database is sensitive to
    // sidecar/permission timing across OSes, and we only need to read the header.
    const probe = openDb(join(home, "ctx.db"));
    const jm = probe.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    probe.close();
    expect(jm?.journal_mode?.toLowerCase()).toBe("wal");

    // Write + read round-trip through migrations/prepared statements.
    expect(run(["remember", "--scope", "global", "--category", "testing", "Write fast unit tests."]).status).toBe(0);
    const prefs = run(["prefs", "--json"]);
    expect(prefs.status).toBe(0);
    const list = JSON.parse(prefs.stdout);
    expect(list).toHaveLength(1);
    expect(list[0].rule).toBe("Write fast unit tests.");

    // doctor's readonly integrity check passes on the node:sqlite file.
    const doctor = run(["doctor", "--json"]);
    const report = JSON.parse(doctor.stdout);
    const integrity = report.checks.find((c: { id: string }) => c.id === "integrity");
    expect(integrity?.status).toBe("ok");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Concurrency under node:sqlite + WAL: many separate Node processes writing at
// once must not lose updates or hit unhandled "database is locked".
//
// This uses ASYNC `spawn` (not `spawnSync`), so the child processes genuinely run
// in parallel — `spawnSync` inside Promise.all would serialize, testing nothing.
// We record each child's live window and assert the peak overlap is > 1 (proving
// real concurrency), then assert the exact final row count (proving no lost/dup
// writes under contention).
test("concurrent Node processes write safely under node:sqlite/WAL", async () => {
  const dist = join(ROOT, "dist", "index.js");
  const node = whichSync("node");
  if (!node || !existsSync(dist)) {
    console.warn("[distribution] skipped concurrency: run `bun run build` first.");
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "ctx-dist-conc-"));
  try {
    const env = { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" };
    spawnSync(node, [dist, "init"], { encoding: "utf8", env });

    interface Span {
      code: number | null;
      stderr: string;
      start: number;
      end: number;
    }
    const runRemember = (i: number): Promise<Span> =>
      new Promise((resolve) => {
        const start = performance.now();
        const child = spawn(
          node,
          [dist, "remember", "--scope", "global", "--category", "general", `Distinct concurrent rule ${i}.`],
          { env },
        );
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("close", (code) => resolve({ code, stderr, start, end: performance.now() }));
      });

    const N = 16;
    // Launch all children first (synchronously kick off spawn), THEN await — this
    // guarantees they are alive simultaneously rather than one-at-a-time.
    const spans = await Promise.all(Array.from({ length: N }, (_, i) => runRemember(i)));

    // Every process succeeded and none surfaced a lock error.
    for (const s of spans) {
      expect(s.code).toBe(0);
      expect(s.stderr).not.toMatch(/database is locked/i);
    }

    // Genuine overlap: sweep the [start,end) windows and take the peak concurrency.
    const events = spans
      .flatMap((s) => [
        { t: s.start, d: 1 },
        { t: s.end, d: -1 },
      ])
      .sort((a, b) => a.t - b.t || a.d - b.d);
    let live = 0;
    let peak = 0;
    for (const e of events) {
      live += e.d;
      if (live > peak) peak = live;
    }
    expect(peak).toBeGreaterThan(1); // processes truly ran at the same time

    // Exact final count: N distinct rules → N rows, no lost or duplicated writes.
    const prefs = spawnSync(node, [dist, "prefs", "--json"], { encoding: "utf8", env });
    const list = JSON.parse(prefs.stdout);
    expect(list).toHaveLength(N);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 90_000);
