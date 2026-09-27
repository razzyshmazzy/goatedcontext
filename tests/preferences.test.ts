import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";
import { ConflictError } from "../src/utils/errors.ts";

test("remember creates an approved preference immediately", () => {
  const t = makeTestContext();
  const pref = t.ctx.preferences.remember({
    rule: "Prefer existing dependencies before installing another package.",
    category: "dependencies",
    scope: "global",
  });
  expect(pref.status).toBe("approved");
  expect(pref.confidence).toBe(1);
  expect(pref.version).toBe(1);
  expect(pref.domain).toBe("dependency-policy");
  expect(pref.polarity).toBe("positive");
  t.cleanup();
});

test("propose creates a proposed (not approved) preference", () => {
  const t = makeTestContext();
  const { preference, merged } = t.ctx.preferences.propose({
    rule: "Prefer extending existing domain services before creating parallel service layers.",
    category: "architecture",
    scope: "global",
    evidence: "User rejected creation of another service layer.",
  });
  expect(merged).toBe(false);
  expect(preference.status).toBe("proposed");
  expect(preference.confidence).toBeLessThan(1);
  t.cleanup();
});

test("similar same-polarity proposals merge and confidence rises deterministically", () => {
  const t = makeTestContext();
  const first = t.ctx.preferences.propose({
    rule: "Prefer extending existing domain services before creating parallel service layers.",
    category: "architecture",
    scope: "global",
    evidence: "rejected a new service layer once",
  });
  const second = t.ctx.preferences.propose({
    rule: "Prefer extending existing domain services rather than new service layers.",
    category: "architecture",
    scope: "global",
    evidence: "rejected a new service layer again",
  });
  expect(second.merged).toBe(true);
  expect(second.preference.id).toBe(first.preference.id);
  expect(t.ctx.preferences.evidenceCount(first.preference.id)).toBe(2);
  expect(second.preference.confidence).toBeCloseTo(0.6, 5);
  t.cleanup();
});

test("CONTRADICTORY proposals never merge (Use Redis vs Never use Redis)", () => {
  const t = makeTestContext();
  const use = t.ctx.preferences.propose({
    rule: "Use Redis.",
    category: "infrastructure",
    scope: "global",
    evidence: "introduced Redis for caching",
  });
  const never = t.ctx.preferences.propose({
    rule: "Never use Redis.",
    category: "infrastructure",
    scope: "global",
    evidence: "asked to remove Redis",
  });
  expect(never.merged).toBe(false);
  expect(never.preference.id).not.toBe(use.preference.id);
  expect(use.preference.polarity).toBe("positive");
  expect(never.preference.polarity).toBe("negative");
  // Evidence stays attached to the correct rule.
  expect(t.ctx.preferences.evidenceFor(use.preference.id).map((e) => e.evidenceText)).toEqual([
    "introduced Redis for caching",
  ]);
  expect(t.ctx.preferences.evidenceFor(never.preference.id).map((e) => e.evidenceText)).toEqual([
    "asked to remove Redis",
  ]);
  t.cleanup();
});

test("more contradiction cases stay distinct", () => {
  const t = makeTestContext();
  const cases: [string, string][] = [
    ["Prefer helper functions.", "Avoid helper functions unless necessary."],
    ["Always use pnpm.", "Do not use pnpm in this repository."],
  ];
  for (const [pos, neg] of cases) {
    const a = t.ctx.preferences.propose({ rule: pos, category: "general", scope: "global", evidence: "x" });
    const b = t.ctx.preferences.propose({ rule: neg, category: "general", scope: "global", evidence: "y" });
    expect(b.preference.id).not.toBe(a.preference.id);
  }
  t.cleanup();
});

test("exact-duplicate evidence is collapsed; distinct evidence accumulates", () => {
  const t = makeTestContext();
  const p = t.ctx.preferences.remember({
    rule: "Prefer boring technology.",
    category: "architecture",
    scope: "global",
    evidence: "initial reasoning",
  });
  t.ctx.preferences.addEvidence(p.id, { source: "agent", repoId: null, text: "initial reasoning" }); // dup
  t.ctx.preferences.addEvidence(p.id, { source: "agent", repoId: null, text: "reinforced later" });
  const texts = t.ctx.preferences.evidenceFor(p.id).map((e) => e.evidenceText);
  expect(texts).toContain("initial reasoning");
  expect(texts).toContain("reinforced later");
  expect(texts.length).toBe(2); // dup collapsed
  t.cleanup();
});

test("lifecycle: approve, reject, forget with optimistic concurrency", () => {
  const t = makeTestContext();
  const { preference } = t.ctx.preferences.propose({
    rule: "Use zod for input validation.",
    category: "dependencies",
    scope: "global",
    evidence: "seen repeatedly",
  });
  const approved = t.ctx.preferences.approve(preference.id, { expectedVersion: preference.version });
  expect(approved.status).toBe("approved");
  expect(approved.version).toBe(preference.version + 1);

  // Stale write is refused (ConflictError), not silently applied.
  expect(() =>
    t.ctx.preferences.reject(preference.id, { expectedVersion: preference.version }),
  ).toThrow(ConflictError);

  // With the fresh version it succeeds.
  const rejected = t.ctx.preferences.reject(preference.id, { expectedVersion: approved.version });
  expect(rejected.status).toBe("rejected");

  t.ctx.preferences.forget(preference.id, { expectedVersion: rejected.version });
  expect(t.ctx.preferences.getById(preference.id)).toBeNull();
  t.cleanup();
});

test("force bypasses the optimistic-concurrency check", () => {
  const t = makeTestContext();
  const { preference } = t.ctx.preferences.propose({
    rule: "Prefer composition over inheritance.",
    category: "architecture",
    scope: "global",
    evidence: "x",
  });
  t.ctx.preferences.approve(preference.id, { expectedVersion: preference.version });
  // stale version, but force applies to current state
  const rejected = t.ctx.preferences.reject(preference.id, { expectedVersion: preference.version, force: true });
  expect(rejected.status).toBe("rejected");
  t.cleanup();
});

test("repo scope without a repo id is rejected", () => {
  const t = makeTestContext();
  expect(() =>
    t.ctx.preferences.remember({ rule: "x rule", category: "general", scope: "repo", repoId: null }),
  ).toThrow();
  t.cleanup();
});
