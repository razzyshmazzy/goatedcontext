import { test, expect } from "bun:test";
import { precedenceRank, outranks, resolveConflict } from "../src/core/retrieval/precedence.ts";
import type { Preference } from "../src/core/preferences/types.ts";

function pref(partial: Partial<Preference>): Preference {
  return {
    id: "x",
    rule: "r",
    category: "c",
    domain: null,
    polarity: "neutral",
    scope: "global",
    repoId: null,
    status: "approved",
    applicability: "relevant",
    condition: null,
    confidence: 1,
    version: 1,
    createdAt: "t",
    updatedAt: "t",
    lastUsedAt: null,
    ...partial,
  };
}

test("precedence ordering matches the documented hierarchy", () => {
  const lockedRepo = pref({ scope: "repo", repoId: "r", status: "locked" });
  const approvedRepo = pref({ scope: "repo", repoId: "r", status: "approved" });
  const lockedGlobal = pref({ scope: "global", status: "locked" });
  const approvedGlobal = pref({ scope: "global", status: "approved" });
  const proposed = pref({ scope: "global", status: "proposed" });

  const ranks = [lockedRepo, approvedRepo, lockedGlobal, approvedGlobal, proposed].map(
    precedenceRank,
  );
  expect(ranks).toEqual([1, 2, 3, 4, 5]);
});

test("rejected preferences are never eligible", () => {
  expect(precedenceRank(pref({ status: "rejected" }))).toBe(Number.POSITIVE_INFINITY);
});

test("repo approved outranks global locked and global approved", () => {
  const repoApproved = pref({ scope: "repo", repoId: "r", status: "approved" });
  const globalLocked = pref({ scope: "global", status: "locked" });
  expect(outranks(repoApproved, globalLocked)).toBe(true);
  expect(resolveConflict(repoApproved, globalLocked)).toBe(repoApproved);
});

test("locked global outranks approved global", () => {
  const lockedGlobal = pref({ scope: "global", status: "locked" });
  const approvedGlobal = pref({ scope: "global", status: "approved" });
  expect(outranks(lockedGlobal, approvedGlobal)).toBe(true);
});
