import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/cli/doctor.ts";

/**
 * Doctor must never recommend DESTRUCTIVE recreation of a data directory as a first
 * step (Wave 3 §12). Permission problems get permission guidance; corruption gets
 * backup-first guidance, never "re-create ~/.ctx (this loses local data)".
 */

// Harmful RECOMMENDATIONS (not a "never delete" warning): losing data, or recreating/
// resetting the data dir as a casual fix.
const DESTRUCTIVE = /loses local data|re-create ~\/\.ctx|reset ~\/\.ctx/i;
const POSIX = process.platform !== "win32";

function home(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("corrupt-database advice is backup-first and not casually destructive", () => {
  const h = home("ctx-advice-corrupt-");
  try {
    writeFileSync(join(h, "ctx.db"), "this is definitely not a sqlite database");
    const report = runDoctor({ version: "0.4.0", env: { CTX_HOME: h, CTX_SECRET_BACKEND: "file" }, skipAdapter: true });
    const failing = report.checks.filter((c) => c.status === "fail" && c.fix);
    expect(failing.length).toBeGreaterThan(0);
    for (const c of failing) {
      expect(c.fix!).not.toMatch(DESTRUCTIVE);
    }
    // At least one failing DB check should guide toward a backup or permission fix.
    expect(failing.some((c) => /backup|permission|ownership/i.test(c.fix!))).toBe(true);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test.if(POSIX)("read-only ~/.ctx: writable-check advice is about permission/ownership, never deletion", () => {
  const base = home("ctx-advice-ro-");
  const h = join(base, ".ctx");
  mkdirSync(h, { recursive: true });
  writeFileSync(join(h, "config.json"), "{}");
  try {
    chmodSync(h, 0o500); // read + execute, NOT writable
    const report = runDoctor({ version: "0.4.0", env: { CTX_HOME: h, CTX_SECRET_BACKEND: "file" }, skipAdapter: true });
    const writable = report.checks.filter((c) => c.id === "db-dir-writable" || c.id === "config-dir-writable");
    const failed = writable.filter((c) => c.status === "fail");
    expect(failed.length).toBeGreaterThan(0); // the read-only dir is detected
    for (const c of failed) {
      expect(c.fix!).toMatch(/permission|ownership/i);
      expect(c.fix!).not.toMatch(/re-create|reset|loses local data/i);
    }
  } finally {
    chmodSync(h, 0o700); // restore so cleanup can remove it
    rmSync(base, { recursive: true, force: true });
  }
});
