import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";

test("remember creates an approved preference immediately", () => {
  const t = makeTestContext();
  const pref = t.ctx.preferences.remember({
    rule: "Prefer existing dependencies before installing another package.",
    category: "dependencies",
    scope: "global",
  });
  expect(pref.status).toBe("approved");
  expect(pref.confidence).toBe(1);
  expect(pref.scope).toBe("global");
  t.cleanup();
});

test("remember --lock creates a locked preference", () => {
  const t = makeTestContext();
  const pref = t.ctx.preferences.remember({
    rule: "Never commit directly to main.",
    category: "conventions",
    scope: "global",
    status: "locked",
  });
  expect(pref.status).toBe("locked");
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

test("proposing a similar rule merges evidence and raises confidence", () => {
  const t = makeTestContext();
  const first = t.ctx.preferences.propose({
    rule: "Prefer extending existing domain services before creating parallel service layers.",
    category: "architecture",
    scope: "global",
    evidence: "User rejected a new service layer once.",
  });
  const second = t.ctx.preferences.propose({
    rule: "Extend existing domain services instead of creating parallel service layers.",
    category: "architecture",
    scope: "global",
    evidence: "User rejected a new service layer again.",
  });
  expect(second.merged).toBe(true);
  expect(second.preference.id).toBe(first.preference.id);
  expect(second.preference.confidence).toBeGreaterThan(first.preference.confidence);
  expect(t.ctx.preferences.evidenceCount(first.preference.id)).toBe(2);
  t.cleanup();
});

test("dissimilar proposals do not merge", () => {
  const t = makeTestContext();
  const a = t.ctx.preferences.propose({
    rule: "Prefer server components in Next.js.",
    category: "architecture",
    scope: "global",
    evidence: "x",
  });
  const b = t.ctx.preferences.propose({
    rule: "Write unit tests for every bug fix.",
    category: "testing",
    scope: "global",
    evidence: "y",
  });
  expect(b.merged).toBe(false);
  expect(b.preference.id).not.toBe(a.preference.id);
  t.cleanup();
});

test("approve, reject and forget move preferences through their lifecycle", () => {
  const t = makeTestContext();
  const { preference } = t.ctx.preferences.propose({
    rule: "Use zod for input validation.",
    category: "dependencies",
    scope: "global",
    evidence: "seen repeatedly",
  });
  expect(t.ctx.preferences.approve(preference.id).status).toBe("approved");
  expect(t.ctx.preferences.reject(preference.id).status).toBe("rejected");
  t.ctx.preferences.forget(preference.id);
  expect(t.ctx.preferences.getById(preference.id)).toBeNull();
  t.cleanup();
});

test("evidence accumulates and is retrievable", () => {
  const t = makeTestContext();
  const pref = t.ctx.preferences.remember({
    rule: "Prefer boring technology.",
    category: "architecture",
    scope: "global",
    evidence: "initial reasoning",
  });
  t.ctx.preferences.addEvidence(pref.id, {
    source: "agent",
    repoId: null,
    text: "reinforced later",
  });
  const evidence = t.ctx.preferences.evidenceFor(pref.id);
  expect(evidence.length).toBe(2);
  expect(evidence.map((e) => e.evidenceText)).toContain("reinforced later");
  t.cleanup();
});

test("resolveRef resolves by unique id prefix", () => {
  const t = makeTestContext();
  const pref = t.ctx.preferences.remember({
    rule: "Prefer composition over inheritance.",
    category: "architecture",
    scope: "global",
  });
  const resolved = t.ctx.preferences.resolveRef(pref.id.slice(0, 8));
  expect(resolved.id).toBe(pref.id);
  t.cleanup();
});

test("repo scope without a repo id is rejected", () => {
  const t = makeTestContext();
  expect(() =>
    t.ctx.preferences.remember({
      rule: "x",
      category: "general",
      scope: "repo",
      repoId: null,
    }),
  ).toThrow();
  t.cleanup();
});
