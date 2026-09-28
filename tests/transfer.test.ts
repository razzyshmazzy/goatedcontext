import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestContext } from "./helpers.ts";
import { exportData, importData, EXPORT_SCHEMA, EXPORT_VERSION } from "../src/core/transfer/transfer.ts";
import { openDatabase } from "../src/storage/sqlite/db.ts";
import { resolvePaths } from "../src/storage/paths.ts";
import { PreferenceService } from "../src/core/preferences/service.ts";

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const TIMEOUT = 60_000;

// ---- export -----------------------------------------------------------------

test("export produces a versioned bundle with a schema tag", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({ rule: "Prefer pnpm for packages.", category: "dependencies", scope: "global" });
  const bundle = exportData(t.ctx);
  expect(bundle.schema).toBe(EXPORT_SCHEMA);
  expect(bundle.version).toBe(EXPORT_VERSION);
  expect(bundle.preferences).toHaveLength(1);
  expect(bundle.preferences[0]!.rule).toBe("Prefer pnpm for packages.");
  t.cleanup();
});

test("export NEVER contains secret values and omits environments", () => {
  const t = makeTestContext();
  const env = t.ctx.environments.add({ name: "supabase-test" });
  const secret = "FAKE_SECRET_sb_zzz_123";
  t.ctx.environments.setVariable(env.id, "SUPABASE_ANON_KEY", secret);
  t.ctx.preferences.remember({ rule: "Prefer parameterized SQL.", category: "security", scope: "global" });
  const bundle = exportData(t.ctx);
  expect(JSON.stringify(bundle)).not.toContain(secret);
  expect(bundle).not.toHaveProperty("environments");
  t.cleanup();
});

// ---- round-trip -------------------------------------------------------------

test("round-trip export → import reproduces global preferences", () => {
  const src = makeTestContext();
  src.ctx.preferences.remember({ rule: "Prefer pnpm for packages.", category: "dependencies", scope: "global" });
  src.ctx.preferences.propose({ rule: "Prefer functional core, imperative shell.", category: "architecture", scope: "global", evidence: "seen" });
  const bundle = exportData(src.ctx);

  const dst = makeTestContext();
  const summary = importData(dst.ctx, bundle);
  expect(summary.imported).toBe(2);
  expect(summary.skipped).toBe(0);

  const rules = dst.ctx.preferences.list().map((p) => p.rule).sort();
  expect(rules).toContain("Prefer pnpm for packages.");
  expect(rules).toContain("Prefer functional core, imperative shell.");
  src.cleanup();
  dst.cleanup();
});

test("import is idempotent — re-importing the same bundle adds nothing", () => {
  const src = makeTestContext();
  src.ctx.preferences.remember({ rule: "Prefer pnpm for packages.", category: "dependencies", scope: "global" });
  const bundle = exportData(src.ctx);

  const dst = makeTestContext();
  const first = importData(dst.ctx, bundle);
  const second = importData(dst.ctx, bundle);
  expect(first.imported).toBe(1);
  expect(second.imported).toBe(0);
  expect(second.skipped).toBe(1);
  expect(dst.ctx.preferences.list()).toHaveLength(1); // no explosion
  src.cleanup();
  dst.cleanup();
});

test("contradictions (opposite polarity, same subject) are preserved", () => {
  const src = makeTestContext();
  src.ctx.preferences.remember({ rule: "Use snapshot testing.", category: "testing", scope: "global" });
  src.ctx.preferences.remember({ rule: "Never use snapshot testing.", category: "testing", scope: "global" });
  const bundle = exportData(src.ctx);

  const dst = makeTestContext();
  const summary = importData(dst.ctx, bundle);
  expect(summary.imported).toBe(2); // both kept — different polarity
  const polarities = dst.ctx.preferences.list().map((p) => p.polarity).sort();
  expect(polarities).toEqual(["negative", "positive"]);
  src.cleanup();
  dst.cleanup();
});

test("repo-scoped preferences round-trip via portable repo identity", () => {
  const src = makeTestContext();
  const repo = src.ctx.repos.resolve(process.cwd());
  expect(repo).not.toBeNull();
  src.ctx.preferences.remember({
    rule: "Use npm in this repo.",
    category: "dependencies",
    domain: "package-manager",
    scope: "repo",
    repoId: repo!.id,
  });
  const bundle = exportData(src.ctx);
  expect(bundle.repos).toHaveLength(1);
  expect(bundle.preferences[0]!.repoIdentity).toBe(repo!.identity);

  const dst = makeTestContext();
  const summary = importData(dst.ctx, bundle);
  expect(summary.imported).toBe(1);
  expect(summary.reposLinked).toBe(1);
  // The dest created a repo with the same identity and linked the preference to it.
  const linked = dst.ctx.repos.getByIdentity(repo!.identity);
  expect(linked).not.toBeNull();
  const imported = dst.ctx.preferences.list()[0]!;
  expect(imported.scope).toBe("repo");
  expect(imported.repoId).toBe(linked!.id);
  src.cleanup();
  dst.cleanup();
});

test("import merges evidence into an equivalent existing preference", () => {
  const src = makeTestContext();
  const p = src.ctx.preferences.remember({
    rule: "Prefer pnpm for packages.",
    category: "dependencies",
    scope: "global",
    evidence: "exported evidence line",
  });
  const bundle = exportData(src.ctx);

  const dst = makeTestContext();
  // Pre-existing equivalent preference (same subject/scope/polarity).
  const existing = dst.ctx.preferences.remember({ rule: "Prefer pnpm for packages.", category: "dependencies", scope: "global" });
  const before = dst.ctx.preferences.evidenceCount(existing.id);
  const summary = importData(dst.ctx, bundle);
  expect(summary.imported).toBe(0);
  expect(summary.skipped).toBe(1);
  expect(dst.ctx.preferences.evidenceCount(existing.id)).toBeGreaterThan(before);
  src.cleanup();
  dst.cleanup();
  void p;
});

// ---- validation -------------------------------------------------------------

test("import rejects a malformed bundle", () => {
  const dst = makeTestContext();
  expect(() => importData(dst.ctx, { not: "a bundle" })).toThrow();
  expect(() => importData(dst.ctx, { schema: "wrong", version: 1, exportedAt: "t", preferences: [] })).toThrow();
  dst.cleanup();
});

// ---- CLI --------------------------------------------------------------------

function seededHome(fn: (p: PreferenceService) => void): string {
  const home = mkdtempSync(join(tmpdir(), "ctx-transfer-"));
  const db = openDatabase(resolvePaths({ CTX_HOME: home }));
  try {
    fn(new PreferenceService(db));
  } finally {
    db.close();
  }
  return home;
}

async function runCli(home: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([BUN, "run", INDEX, ...args], {
    env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
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
  "CLI export → import round-trips through a file",
  async () => {
    const srcHome = seededHome((p) => {
      p.remember({ rule: "Prefer pnpm for packages.", category: "dependencies", scope: "global" });
      p.remember({ rule: "Write focused unit tests.", category: "testing", scope: "global" });
    });
    const exp = await runCli(srcHome, ["export"]);
    expect(exp.code).toBe(0);
    const bundle = JSON.parse(exp.out);
    expect(bundle.schema).toBe(EXPORT_SCHEMA);

    const file = join(tmpdir(), `ctx-bundle-${process.pid}.json`);
    writeFileSync(file, JSON.stringify(bundle), "utf8");

    const dstHome = seededHome(() => {});
    const imp = await runCli(dstHome, ["import", file, "--json"]);
    expect(imp.code).toBe(0);
    expect(JSON.parse(imp.out).imported).toBe(2);

    // Verify the preferences actually landed.
    const list = await runCli(dstHome, ["prefs", "--json"]);
    expect(JSON.parse(list.out)).toHaveLength(2);

    rmSync(srcHome, { recursive: true, force: true });
    rmSync(dstHome, { recursive: true, force: true });
    rmSync(file, { force: true });
  },
  TIMEOUT,
);

test(
  "CLI import errors cleanly on invalid JSON",
  async () => {
    const home = seededHome(() => {});
    const file = join(tmpdir(), `ctx-bad-${process.pid}.json`);
    writeFileSync(file, "{ not valid json", "utf8");
    const { code, err } = await runCli(home, ["import", file]);
    expect(code).not.toBe(0);
    expect(err).toContain("not valid JSON");
    rmSync(home, { recursive: true, force: true });
    rmSync(file, { force: true });
  },
  TIMEOUT,
);

test("readFileSync of --out bundle is valid (sanity)", () => {
  // Guards against accidental non-JSON output shape from exportData.
  const t = makeTestContext();
  t.ctx.preferences.remember({ rule: "Prefer pnpm.", category: "dependencies", scope: "global" });
  const bundle = exportData(t.ctx);
  const file = join(tmpdir(), `ctx-out-${process.pid}.json`);
  writeFileSync(file, JSON.stringify(bundle, null, 2));
  const reparsed = JSON.parse(readFileSync(file, "utf8"));
  expect(reparsed.preferences[0].rule).toBe("Prefer pnpm.");
  rmSync(file, { force: true });
  t.cleanup();
});
