import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";

test("retrieval returns relevant global preferences for a task", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({
    rule: "Prefer existing dependencies before installing another package.",
    category: "dependencies",
    scope: "global",
  });
  const result = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    task: "Add a date formatting helper",
  });
  const rules = result.preferences.map((p) => p.rule);
  expect(rules).toContain("Prefer existing dependencies before installing another package.");
  t.cleanup();
});

test("retrieval excludes proposed preferences by default but includes them on request", () => {
  const t = makeTestContext();
  t.ctx.preferences.propose({
    rule: "Prefer functional core, imperative shell.",
    category: "architecture",
    scope: "global",
    evidence: "observed",
  });
  const without = t.ctx.retrieval.retrieve({ cwd: process.cwd() });
  expect(without.preferences.length).toBe(0);

  const withProposed = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    includeProposed: true,
  });
  expect(withProposed.preferences.length).toBe(1);
  t.cleanup();
});

test("rejected preferences never appear in retrieval", () => {
  const t = makeTestContext();
  const p = t.ctx.preferences.remember({
    rule: "Prefer tabs.",
    category: "conventions",
    scope: "global",
  });
  t.ctx.preferences.reject(p.id);
  const result = t.ctx.retrieval.retrieve({ cwd: process.cwd(), includeProposed: true });
  expect(result.preferences.length).toBe(0);
  t.cleanup();
});

test("repo preference overrides a conflicting global preference", () => {
  const t = makeTestContext();
  const repo = t.ctx.repos.resolve(process.cwd());
  expect(repo).not.toBeNull();

  const globalPref = t.ctx.preferences.remember({
    rule: "Prefer tabs for code indentation style.",
    category: "conventions",
    scope: "global",
  });
  const repoPref = t.ctx.preferences.remember({
    rule: "Prefer spaces for code indentation style.",
    category: "conventions",
    scope: "repo",
    repoId: repo!.id,
  });

  const result = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    task: "code indentation style",
  });
  const rules = result.preferences.map((p) => p.rule);
  expect(rules).toContain(repoPref.rule);
  expect(rules).not.toContain(globalPref.rule);
  expect(result.overridden.map((o) => o.id)).toContain(globalPref.id);
  t.cleanup();
});

test("retrieval respects the limit and stays within 1..15", () => {
  const t = makeTestContext();
  // Distinct topics so conflict resolution does not collapse them together.
  const topics = [
    "database indexing", "logging format", "error handling", "caching layer",
    "http retries", "feature flags", "queue processing", "image resizing",
    "email templating", "pagination cursors", "rate limiting", "audit trails",
    "session storage", "webhook signing", "cron scheduling", "search ranking",
    "file uploads", "pdf rendering", "graph traversal", "color palettes",
  ];
  for (const topic of topics) {
    t.ctx.preferences.remember({
      rule: `Follow the house style for ${topic}.`,
      category: topic,
      scope: "global",
    });
  }
  const result = t.ctx.retrieval.retrieve({ cwd: process.cwd(), limit: 5 });
  expect(result.preferences.length).toBe(5);

  const capped = t.ctx.retrieval.retrieve({ cwd: process.cwd(), limit: 999 });
  expect(capped.preferences.length).toBeLessThanOrEqual(15);
  t.cleanup();
});

test("retrieval marks returned preferences as used", () => {
  const t = makeTestContext();
  const p = t.ctx.preferences.remember({
    rule: "Prefer small pull requests.",
    category: "conventions",
    scope: "global",
  });
  expect(t.ctx.preferences.getById(p.id)!.lastUsedAt).toBeNull();
  t.ctx.retrieval.retrieve({ cwd: process.cwd() });
  expect(t.ctx.preferences.getById(p.id)!.lastUsedAt).not.toBeNull();
  t.cleanup();
});
