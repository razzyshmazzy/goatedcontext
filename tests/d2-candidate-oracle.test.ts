import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";
import { generateDataset, bulkSeed } from "./bench/fixtures.ts";
import { ACTIVE_STATUSES } from "../src/core/preferences/types.ts";
import type { Preference } from "../src/core/preferences/types.ts";
import type { PreferenceService } from "../src/core/preferences/service.ts";

/**
 * D2 semantic oracle (0.3.0, CI-blocking). The SQL candidate reduction
 * (`listCandidates`) must be DEEPLY EQUAL to the canonical pre-0.3.0 path —
 * `list()` fully materialized, then filtered in JS by status + scope/repo. If these
 * ever diverge, the optimization is wrong and this test fails. No performance claim
 * is asserted here (that is in scripts/bench); only correctness.
 */

/** The exact pre-0.3.0 candidate semantics, reproduced as the reference oracle. */
function oracleCandidates(
  prefs: PreferenceService,
  repoId: string | null,
  includeProposed: boolean,
): Preference[] {
  const statuses: string[] = includeProposed
    ? [...ACTIVE_STATUSES, "proposed", "observed"]
    : [...ACTIVE_STATUSES];
  return prefs.list().filter((p) => {
    if (!statuses.includes(p.status)) return false;
    if (p.scope === "global") return true;
    if (p.scope === "repo") return repoId != null && p.repoId === repoId;
    return false;
  });
}

function assertDeepEqualCandidates(a: Preference[], b: Preference[]) {
  expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id)); // same rows, same order
  expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // same field-for-field content
}

test.each([100, 1_000, 10_000])(
  "listCandidates === list()+JS-filter oracle at %d prefs (global + a real repo, both status modes)",
  (n) => {
    const t = makeTestContext();
    try {
      const { repoIds } = bulkSeed(t.ctx.db, generateDataset(n, { seed: 7, repoCount: Math.max(2, Math.min(50, Math.floor(n / 20))) }));
      const repoId = repoIds[0]!;
      for (const includeProposed of [false, true]) {
        // No-repo context.
        assertDeepEqualCandidates(
          t.ctx.preferences.listCandidates({ repoId: null, includeProposed }),
          oracleCandidates(t.ctx.preferences, null, includeProposed),
        );
        // A specific repo context.
        assertDeepEqualCandidates(
          t.ctx.preferences.listCandidates({ repoId, includeProposed }),
          oracleCandidates(t.ctx.preferences, repoId, includeProposed),
        );
      }
    } finally {
      t.cleanup();
    }
  },
);

test("the SQL candidate set EXCLUDES unrelated repos' rows (isolation + reduction, 100 repos / 10k)", () => {
  const t = makeTestContext();
  try {
    const { repoIds } = bulkSeed(t.ctx.db, generateDataset(10_000, { seed: 8, repoCount: 100 }));
    const total = t.ctx.preferences.list().length;
    const repoId = repoIds[0]!;

    const candidates = t.ctx.preferences.listCandidates({ repoId });
    // Every candidate is global, or repo-scoped bound to THIS repo — never another repo.
    for (const c of candidates) {
      if (c.scope === "repo") expect(c.repoId).toBe(repoId);
      expect(["global", "repo"]).toContain(c.scope);
    }
    // And the candidate count is materially below the full row count (other repos
    // are not even loaded) — the whole point of the D2 reduction.
    expect(candidates.length).toBeLessThan(total);
    expect(candidates.length).toBeLessThan(total * 0.75);
  } finally {
    t.cleanup();
  }
});

test("the repo branch uses the repo_id index (query plan does not scan unrelated repos)", () => {
  const t = makeTestContext();
  try {
    bulkSeed(t.ctx.db, generateDataset(2_000, { seed: 9, repoCount: 40 }));
    const plan = t.ctx.db
      .query<{ detail: string }, unknown[]>(
        `EXPLAIN QUERY PLAN
         SELECT * FROM preferences WHERE scope = 'global' AND status IN (?, ?)
         UNION ALL
         SELECT * FROM preferences WHERE scope = 'repo' AND repo_id = ? AND status IN (?, ?)
         ORDER BY updated_at DESC, id ASC`,
      )
      .all("locked", "approved", "x", "locked", "approved")
      .map((r) => r.detail)
      .join(" | ");
    // The repo branch must seek by repo_id, not table-scan.
    expect(plan).toContain("idx_prefs_repo");
    expect(plan).not.toContain("SCAN preferences"); // no full table scan of the preferences table
  } finally {
    t.cleanup();
  }
});
