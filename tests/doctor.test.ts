import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, renderDoctor, type DoctorReport, type CheckStatus } from "../src/cli/doctor.ts";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { installClaude } from "../src/adapters/claude/installer.ts";

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const TIMEOUT = 60_000;

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A fully initialized ctx home (db + config created by opening the database). */
function initHome(): string {
  const home = tmp("ctx-doctor-home-");
  const db = openDatabase(resolvePaths({ CTX_HOME: home }));
  db.close();
  return home;
}

function check(report: DoctorReport, id: string) {
  const c = report.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check with id "${id}"`);
  return c;
}

/** A resolver that always finds the executable (simulates ctx on PATH). */
const alwaysFound = () => "/usr/bin/ctx";
/** A resolver that never finds the executable (simulates ctx missing from PATH). */
const neverFound = () => null;

test("healthy install passes every check", () => {
  const home = initHome();
  const claudeHome = tmp("ctx-doctor-claude-");
  installClaude({ claudeHome });

  const report = runDoctor({
    version: "0.1.2",
    env: { CTX_HOME: home, CTX_SECRET_BACKEND: "file", PATH: process.env.PATH },
    claudeHome,
    which: alwaysFound,
  });

  expect(report.ok).toBe(true);
  expect(check(report, "db-readable").status).toBe("ok");
  expect(check(report, "integrity").status).toBe("ok");
  expect(check(report, "schema").status).toBe("ok");
  expect(check(report, "skills").status).toBe("ok");
  expect(check(report, "instructions").status).toBe("ok");
  expect(check(report, "hook").status).toBe("ok");
  expect(check(report, "hook-on-path").status).toBe("ok");
  // No failing checks in a healthy install.
  expect(report.checks.filter((c) => c.status === "fail")).toHaveLength(0);

  rmSync(home, { recursive: true, force: true });
  rmSync(claudeHome, { recursive: true, force: true });
});

test("ctx missing from PATH fails the hook-on-path check with a fix", () => {
  const home = initHome();
  const claudeHome = tmp("ctx-doctor-claude-");
  installClaude({ claudeHome });

  const report = runDoctor({
    version: "0.1.2",
    env: { CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    claudeHome,
    which: neverFound,
  });

  const c = check(report, "hook-on-path");
  expect(c.status).toBe("fail");
  expect(c.fix).toContain("setup");
  expect(report.ok).toBe(false);

  rmSync(home, { recursive: true, force: true });
  rmSync(claudeHome, { recursive: true, force: true });
});

test("missing Claude adapter reports hook/skills as failures", () => {
  const home = initHome();
  const claudeHome = tmp("ctx-doctor-claude-"); // exists but empty (no install)

  const report = runDoctor({
    version: "0.1.2",
    env: { CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    claudeHome,
    which: alwaysFound,
  });

  expect(check(report, "skills").status).toBe("fail");
  expect(check(report, "instructions").status).toBe("fail");
  expect(check(report, "hook").status).toBe("fail");
  expect(report.ok).toBe(false);

  rmSync(home, { recursive: true, force: true });
  rmSync(claudeHome, { recursive: true, force: true });
});

test("--skip-adapter omits the Claude checks and passes without an install", () => {
  const home = initHome();
  const claudeHome = tmp("ctx-doctor-claude-"); // exists but empty (no install)

  const report = runDoctor({
    version: "0.1.2",
    env: { CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    claudeHome,
    which: neverFound,
    skipAdapter: true,
  });

  // None of the optional Claude adapter checks are present…
  for (const id of ["claude-home", "skills", "instructions", "hook", "hook-on-path"]) {
    expect(report.checks.find((c) => c.id === id)).toBeUndefined();
  }
  // …and the report is healthy despite Claude not being installed.
  expect(report.ok).toBe(true);
  // Core checks still ran.
  expect(check(report, "db-readable").status).toBe("ok");
  expect(check(report, "integrity").status).toBe("ok");

  rmSync(home, { recursive: true, force: true });
  rmSync(claudeHome, { recursive: true, force: true });
});

test("--skip-adapter still FAILS on a real database error", () => {
  const home = tmp("ctx-doctor-home-");
  mkdirSync(home, { recursive: true });
  // Garbage where the DB should be — a genuine runtime/DB error CI must catch.
  writeFileSync(join(home, "ctx.db"), "this is definitely not a sqlite database", "utf8");

  const report = runDoctor({
    version: "0.1.2",
    env: { CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    which: neverFound,
    skipAdapter: true,
  });

  // Skipping the adapter must NOT mask real DB failures.
  const readable = check(report, "db-readable");
  const failing: CheckStatus[] = [readable.status];
  const integrity = report.checks.find((c) => c.id === "integrity");
  if (integrity) failing.push(integrity.status);
  expect(failing).toContain("fail");
  expect(report.ok).toBe(false);

  rmSync(home, { recursive: true, force: true });
});

test("malformed config.json is reported as a failure", () => {
  const home = initHome();
  writeFileSync(join(home, "config.json"), "{ this is : not valid json", "utf8");

  const report = runDoctor({
    version: "0.1.2",
    env: { CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    which: alwaysFound,
  });

  const c = check(report, "config-valid");
  expect(c.status).toBe("fail");
  expect(c.fix).toContain("config.json");
  expect(report.ok).toBe(false);

  rmSync(home, { recursive: true, force: true });
});

test("corrupt database fails the integrity check", () => {
  const home = tmp("ctx-doctor-home-");
  mkdirSync(home, { recursive: true });
  // Write garbage where the DB file should be — not a valid SQLite file.
  writeFileSync(join(home, "ctx.db"), "this is definitely not a sqlite database", "utf8");

  const report = runDoctor({
    version: "0.1.2",
    env: { CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    which: alwaysFound,
  });

  // Either opening fails or integrity_check fails — either way it's not "ok".
  const readable = check(report, "db-readable");
  const failing: CheckStatus[] = [readable.status];
  const integrity = report.checks.find((c) => c.id === "integrity");
  if (integrity) failing.push(integrity.status);
  expect(failing).toContain("fail");
  expect(report.ok).toBe(false);

  rmSync(home, { recursive: true, force: true });
});

test("file secret backend raises a fallback warning (never a secret value)", () => {
  const home = initHome();
  const claudeHome = tmp("ctx-doctor-claude-");
  installClaude({ claudeHome });

  const report = runDoctor({
    version: "0.1.2",
    env: { CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    claudeHome,
    which: alwaysFound,
  });

  const c = check(report, "secret-backend");
  expect(c.status).toBe("warn");
  expect(c.detail).toContain("encrypted-file");
  // Warnings should not, by themselves, mark the install unhealthy.
  expect(report.ok).toBe(true);

  rmSync(home, { recursive: true, force: true });
  rmSync(claudeHome, { recursive: true, force: true });
});

test("uninitialized home warns about a missing database and config", () => {
  const home = join(tmp("ctx-doctor-empty-"), "not-created-yet");

  const report = runDoctor({
    version: "0.1.2",
    env: { CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    which: alwaysFound,
  });

  expect(check(report, "db-readable").status).toBe("warn");
  expect(check(report, "config-valid").status).toBe("warn");

  rmSync(home, { recursive: true, force: true });
});

test("renderDoctor produces grouped, symbol-prefixed lines", () => {
  const home = initHome();
  const claudeHome = tmp("ctx-doctor-claude-");
  installClaude({ claudeHome });
  const report = runDoctor({
    version: "0.1.2",
    env: { CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    claudeHome,
    which: alwaysFound,
  });
  const text = renderDoctor(report).join("\n");
  expect(text).toContain("ctx doctor — 0.1.2");
  expect(text).toContain("Claude:");
  expect(text).toMatch(/[✓!✗] /);

  rmSync(home, { recursive: true, force: true });
  rmSync(claudeHome, { recursive: true, force: true });
});

test(
  "doctor --json emits a valid report over the CLI",
  async () => {
    const home = initHome();
    const proc = Bun.spawn([BUN, "run", INDEX, "doctor", "--json"], {
      env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const parsed = JSON.parse(out) as DoctorReport;
    expect(typeof parsed.ok).toBe("boolean");
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.some((c) => c.id === "integrity")).toBe(true);
    // The JSON output must not leak any secret material.
    expect(out).not.toContain("secret.key");
    rmSync(home, { recursive: true, force: true });
  },
  TIMEOUT,
);
