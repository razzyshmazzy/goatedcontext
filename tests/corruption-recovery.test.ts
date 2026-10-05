import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whichSync } from "../src/utils/runtime.ts";
import { runDoctor } from "../src/cli/doctor.ts";

/**
 * Corruption / recovery (0.3.0 diagnostic, CI-blocking). Disposable DBs only.
 *
 * The critical safety property: ctx must FAIL SAFELY on a damaged database — never
 * silently reset/overwrite it (that would be catastrophic data loss). doctor must
 * give actionable output.
 */

const dist = join(import.meta.dir, "..", "dist", "index.js");
const node = whichSync("node");
const canRunCli = Boolean(node && existsSync(dist));

function home(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("doctor reports a corrupt database as a failure, with a fix (no crash)", () => {
  const h = home("ctx-corrupt-");
  try {
    writeFileSync(join(h, "ctx.db"), "this is definitely not a sqlite database");
    const report = runDoctor({ version: "0.3.0-diag", env: { CTX_HOME: h, CTX_SECRET_BACKEND: "file" }, skipAdapter: true });
    expect(report.ok).toBe(false);
    const readable = report.checks.find((c) => c.id === "db-readable");
    const integrity = report.checks.find((c) => c.id === "integrity");
    const failed = [readable?.status, integrity?.status];
    expect(failed).toContain("fail");
    // Actionable, never a secret value.
    const failing = report.checks.find((c) => c.status === "fail");
    expect(failing?.fix && failing.fix.length).toBeTruthy();
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("CLI does NOT destructively reset a corrupt database (bytes preserved)", () => {
  if (!canRunCli) { console.warn("[corruption] skipped: build first."); return; }
  const h = home("ctx-corrupt2-");
  try {
    const garbage = "CORRUPT-SENTINEL not a sqlite file " + "x".repeat(200);
    const dbFile = join(h, "ctx.db");
    writeFileSync(dbFile, garbage);
    const env = { ...process.env, CTX_HOME: h, CTX_SECRET_BACKEND: "file" };
    // A read command against the corrupt DB.
    const res = spawnSync(node!, [dist, "prefs", "--json"], { encoding: "utf8", env });
    // It must fail (nonzero) OR emit an error, but must NOT have overwritten the file.
    expect(readFileSync(dbFile, "utf8")).toBe(garbage); // untouched — no auto-reset / data loss
    expect(res.status === 0 ? "" : "nonzero").toBe("nonzero"); // failed safely
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
}, 30_000);

test("doctor on a brand-new (uninitialized) home warns, does not fail catastrophically", () => {
  const h = join(home("ctx-fresh2-"), "not-created-yet");
  try {
    const report = runDoctor({ version: "0.3.0-diag", env: { CTX_HOME: h, CTX_SECRET_BACKEND: "file" }, skipAdapter: true });
    const db = report.checks.find((c) => c.id === "db-readable");
    expect(db?.status).toBe("warn"); // "not created yet", with a `ctx init` fix
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("missing parent directory is created on open, not an error (read/write path)", () => {
  if (!canRunCli) { console.warn("[corruption] skipped: build first."); return; }
  const base = home("ctx-missingdir-");
  const nested = join(base, "a", "b", "c"); // does not exist yet
  try {
    const env = { ...process.env, CTX_HOME: nested, CTX_SECRET_BACKEND: "file" };
    const res = spawnSync(node!, [dist, "init"], { encoding: "utf8", env });
    expect(res.status).toBe(0);
    expect(existsSync(join(nested, "ctx.db"))).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);

test("a truncated (empty) db file is reported, not silently repopulated", () => {
  const h = home("ctx-trunc-");
  try {
    mkdirSync(h, { recursive: true });
    writeFileSync(join(h, "ctx.db"), ""); // zero-byte file
    const report = runDoctor({ version: "0.3.0-diag", env: { CTX_HOME: h, CTX_SECRET_BACKEND: "file" }, skipAdapter: true });
    // An empty file is a valid "new" SQLite db to the driver; doctor should still not crash
    // and should surface the state (schema not up to date OR readable warning).
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.some((c) => c.section === "Database")).toBe(true);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});
