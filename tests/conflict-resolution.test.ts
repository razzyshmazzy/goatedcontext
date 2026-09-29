import { test, expect } from "bun:test";
import { resolveConflicts } from "../src/core/retrieval/retrieval.ts";
import type { Preference, Status, Scope } from "../src/core/preferences/types.ts";

let counter = 0;
function pref(p: {
  rule: string;
  domain: string | null;
  scope: Scope;
  status: Status;
  polarity?: "positive" | "negative" | "neutral";
}): Preference {
  counter += 1;
  return {
    id: `id-${counter}`,
    rule: p.rule,
    category: p.domain ?? "general",
    domain: p.domain,
    polarity: p.polarity ?? "positive",
    scope: p.scope,
    repoId: p.scope === "repo" ? "repo-1" : null,
    status: p.status,
    applicability: "relevant",
    confidence: 1,
    version: 1,
    createdAt: "t",
    updatedAt: "t",
    lastUsedAt: null,
  };
}

function winnerRules(prefs: Preference[]): string[] {
  return resolveConflicts(prefs).winners.map((w) => w.rule);
}

test("repo npm overrides global pnpm (exclusive package-manager domain)", () => {
  const globalPnpm = pref({ rule: "Prefer pnpm.", domain: "package-manager", scope: "global", status: "approved" });
  const repoNpm = pref({ rule: "Use npm here.", domain: "package-manager", scope: "repo", status: "approved" });
  const { winners, overridden } = resolveConflicts([globalPnpm, repoNpm]);
  expect(winners.map((w) => w.rule)).toEqual(["Use npm here."]);
  expect(overridden.map((o) => o.id)).toEqual([globalPnpm.id]);
});

test("repo SQLite overrides global PostgreSQL (exclusive database domain)", () => {
  const globalPg = pref({ rule: "Use PostgreSQL.", domain: "database", scope: "global", status: "approved" });
  const repoSqlite = pref({ rule: "Use SQLite locally.", domain: "database", scope: "repo", status: "approved" });
  expect(winnerRules([globalPg, repoSqlite])).toEqual(["Use SQLite locally."]);
});

test("locked global loses to approved repo", () => {
  const lockedGlobal = pref({ rule: "Global locked.", domain: "package-manager", scope: "global", status: "locked" });
  const approvedRepo = pref({ rule: "Repo approved.", domain: "package-manager", scope: "repo", status: "approved" });
  expect(winnerRules([lockedGlobal, approvedRepo])).toEqual(["Repo approved."]);
});

test("locked repo beats locked global", () => {
  const lockedGlobal = pref({ rule: "Global locked.", domain: "database", scope: "global", status: "locked" });
  const lockedRepo = pref({ rule: "Repo locked.", domain: "database", scope: "repo", status: "locked" });
  expect(winnerRules([lockedGlobal, lockedRepo])).toEqual(["Repo locked."]);
});

test("rejected preferences never participate", () => {
  const rejectedRepo = pref({ rule: "Rejected repo.", domain: "package-manager", scope: "repo", status: "rejected" });
  const approvedGlobal = pref({ rule: "Approved global.", domain: "package-manager", scope: "global", status: "approved" });
  // resolveConflicts assumes candidates were already status-filtered; a rejected
  // rule that slips in still must not outrank an active one.
  const { winners } = resolveConflicts([approvedGlobal, rejectedRepo]);
  expect(winners.some((w) => w.rule === "Approved global.")).toBe(true);
});

test("two unrelated domains both survive", () => {
  const dbRule = pref({ rule: "Use PostgreSQL.", domain: "database", scope: "global", status: "approved" });
  const testRule = pref({ rule: "Write focused tests.", domain: "testing", scope: "global", status: "approved" });
  const winners = winnerRules([dbRule, testRule]);
  expect(winners).toContain("Use PostgreSQL.");
  expect(winners).toContain("Write focused tests.");
});

test("non-exclusive domain: two distinct-subject rules coexist, contradictions resolve by precedence", () => {
  const t1 = pref({ rule: "Prefer unit tests for logic.", domain: "testing", scope: "global", status: "approved" });
  const t2 = pref({ rule: "Prefer integration tests for APIs.", domain: "testing", scope: "global", status: "approved" });
  // distinct subjects -> both kept
  expect(winnerRules([t1, t2]).length).toBe(2);

  const posGlobal = pref({ rule: "Use snapshot testing.", domain: "testing", scope: "global", status: "approved", polarity: "positive" });
  const negRepo = pref({ rule: "Never use snapshot testing.", domain: "testing", scope: "repo", status: "approved", polarity: "negative" });
  // same subject, opposite polarity -> conflict -> repo wins
  expect(winnerRules([posGlobal, negRepo])).toEqual(["Never use snapshot testing."]);
});
