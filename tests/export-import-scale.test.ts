import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";
import { generateDataset, bulkSeed } from "./bench/fixtures.ts";
import { exportData, importData } from "../src/core/transfer/transfer.ts";

/**
 * Export / import scale + semantic round-trip (0.3.0 diagnostic, CI-blocking).
 * Larger 10k/50k timing lives in scripts/bench; here we assert correctness at a
 * CI-friendly size.
 */

const SIZE = 2_000;

function countByKey(prefs: { scope: string; status: string; applicability: string; condition: unknown }[]) {
  const key = (p: { scope: string; status: string; applicability: string }) => `${p.scope}|${p.status}|${p.applicability}`;
  const m = new Map<string, number>();
  for (const p of prefs) m.set(key(p), (m.get(key(p)) ?? 0) + 1);
  return m;
}

test("export → import into a fresh store is LOSSLESS for distinct preferences (scope/status/applicability/condition)", () => {
  const src = makeTestContext();
  const dst = makeTestContext();
  try {
    // Uniquify rule text so the source has NO internal dedup-key collisions — then
    // import must preserve every row exactly (import intentionally collapses genuine
    // duplicates, which is covered separately by the idempotence test).
    const dataset = generateDataset(SIZE, { seed: 77, repoCount: 12 });
    dataset.prefs = dataset.prefs.map((p, i) => ({ ...p, rule: `${p.rule} [uniq-${i}]` }));
    bulkSeed(src.ctx.db, dataset);
    const srcPrefs = src.ctx.preferences.list();

    const bundle = exportData(src.ctx);
    const summary = importData(dst.ctx, bundle);

    expect(summary.total).toBe(bundle.preferences.length);
    const dstPrefs = dst.ctx.preferences.list();

    // Semantic distribution is preserved (rejected rows are exported & imported too).
    const srcDist = countByKey(srcPrefs);
    const dstDist = countByKey(dstPrefs);
    expect(dstDist).toEqual(srcDist);

    // Every conditional kept a condition; every relevant/always kept none (invariant).
    for (const p of dstPrefs) {
      if (p.applicability === "conditional") expect(p.condition).not.toBeNull();
      else expect(p.condition).toBeNull();
    }
  } finally {
    src.cleanup();
    dst.cleanup();
  }
});

test("re-import of the same bundle is idempotent (no duplicate explosion)", () => {
  const src = makeTestContext();
  const dst = makeTestContext();
  try {
    bulkSeed(src.ctx.db, generateDataset(1_000, { seed: 88, repoCount: 6 }));
    const bundle = exportData(src.ctx);
    const first = importData(dst.ctx, bundle);
    const countAfterFirst = dst.ctx.preferences.list().length;
    const second = importData(dst.ctx, bundle);
    const countAfterSecond = dst.ctx.preferences.list().length;

    expect(countAfterSecond).toBe(countAfterFirst); // no new rows on re-import
    expect(second.imported).toBe(0); // everything deduped
    expect(first.imported).toBeGreaterThan(0);
  } finally {
    src.cleanup();
    dst.cleanup();
  }
});

test("export bundle carries no local row ids and no secret material", () => {
  const src = makeTestContext();
  try {
    const env = src.ctx.environments.add({ name: "db-test", scope: "global", repoId: null, riskLevel: "test", description: null });
    src.ctx.environments.setVariable(env.id, "DB_PASSWORD", "p@ssw0rd-NEVER-LEAK");
    bulkSeed(src.ctx.db, generateDataset(300, { seed: 99 }));
    const text = JSON.stringify(exportData(src.ctx));
    expect(text).not.toContain("p@ssw0rd-NEVER-LEAK");
    expect(text).not.toContain("DB_PASSWORD");
    // Bundle links repos by stable identity, not local ids.
    const bundle = exportData(src.ctx);
    for (const r of bundle.repos) expect(r.identity.startsWith("remote:") || r.identity.startsWith("path:")).toBe(true);
  } finally {
    src.cleanup();
  }
});
