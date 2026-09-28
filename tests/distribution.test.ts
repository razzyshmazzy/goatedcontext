import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
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
    // away on clean close, so we reopen and read the journal mode instead).
    const probe = openDb(join(home, "ctx.db"), { readonly: true });
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

    const N = 12;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        new Promise<void>((resolve, reject) => {
          const p = spawnSync(
            node,
            [dist, "remember", "--scope", "global", "--category", "general", `Distinct concurrent rule ${i}.`],
            { encoding: "utf8", env },
          );
          if (p.status === 0 && !/(database is locked)/i.test(p.stderr)) resolve();
          else reject(new Error(`proc ${i} failed: code=${p.status} err=${p.stderr}`));
        }),
      ),
    );

    const prefs = spawnSync(node, [dist, "prefs", "--json"], { encoding: "utf8", env });
    const list = JSON.parse(prefs.stdout);
    expect(list).toHaveLength(N); // no lost writes
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 90_000);
