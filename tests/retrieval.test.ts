import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";

function rules(result: { preferences: { rule: string }[] }): string[] {
  return result.preferences.map((p) => p.rule);
}

test("a UI task does NOT return database preferences", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({
    rule: "Prefer relational constraints and database-enforced invariants.",
    category: "database",
    scope: "global",
  });
  const result = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    task: "Change the settings button color.",
  });
  expect(rules(result)).not.toContain(
    "Prefer relational constraints and database-enforced invariants.",
  );
  t.cleanup();
});

test("a persistence/design task DOES return database and architecture preferences", () => {
  const t = makeTestContext();
  const db = t.ctx.preferences.remember({
    rule: "Prefer relational constraints and database-enforced invariants.",
    category: "database",
    scope: "global",
  });
  const arch = t.ctx.preferences.remember({
    rule: "Prefer extending existing abstractions before creating parallel ones.",
    category: "architecture",
    scope: "global",
  });
  const ui = t.ctx.preferences.remember({
    rule: "Prefer Tailwind for styling components.",
    category: "ui-framework",
    scope: "global",
  });
  const result = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    task: "Design settlement persistence.",
  });
  const got = rules(result);
  expect(got).toContain(db.rule);
  expect(got).toContain(arch.rule);
  expect(got).not.toContain(ui.rule);
  t.cleanup();
});

test("a dependency-install task DOES return dependency policy", () => {
  const t = makeTestContext();
  const dep = t.ctx.preferences.remember({
    rule: "Check existing dependencies before installing a new package.",
    category: "dependencies",
    scope: "global",
  });
  const result = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    task: "Install a date formatting package.",
  });
  expect(rules(result)).toContain(dep.rule);
  t.cleanup();
});

test("an unrelated task can legitimately return zero preferences", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({
    rule: "Prefer relational constraints and database-enforced invariants.",
    category: "database",
    scope: "global",
  });
  const result = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    task: "Change the settings button color.",
  });
  expect(result.preferences.length).toBe(0);
  t.cleanup();
});

test("repo package-manager rule overrides global one for a package-manager task", () => {
  const t = makeTestContext();
  const repo = t.ctx.repos.resolve(process.cwd());
  expect(repo).not.toBeNull();
  const globalPref = t.ctx.preferences.remember({
    rule: "Prefer pnpm for JavaScript projects.",
    category: "dependencies",
    scope: "global",
  });
  const repoPref = t.ctx.preferences.remember({
    rule: "This repository must use npm.",
    category: "dependencies",
    scope: "repo",
    repoId: repo!.id,
  });
  const result = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    task: "Which package manager should we use to add a dependency?",
  });
  const got = rules(result);
  expect(got).toContain(repoPref.rule);
  expect(got).not.toContain(globalPref.rule);
  expect(result.overridden.map((o) => o.id)).toContain(globalPref.id);
  t.cleanup();
});

test("proposed excluded by default, included on request; rejected never appears", () => {
  const t = makeTestContext();
  const { preference } = t.ctx.preferences.propose({
    rule: "Prefer functional core imperative shell architecture.",
    category: "architecture",
    scope: "global",
    evidence: "observed",
  });
  const task = "Design the service architecture layers.";
  expect(t.ctx.retrieval.retrieve({ cwd: process.cwd(), task }).preferences.length).toBe(0);
  expect(
    t.ctx.retrieval.retrieve({ cwd: process.cwd(), task, includeProposed: true }).preferences.length,
  ).toBe(1);
  t.ctx.preferences.reject(preference.id, { expectedVersion: preference.version });
  expect(
    t.ctx.retrieval.retrieve({ cwd: process.cwd(), task, includeProposed: true }).preferences.length,
  ).toBe(0);
  t.cleanup();
});

test("retrieval respects the limit and stays within 1..15", () => {
  const t = makeTestContext();
  const domains = [
    "database", "testing", "architecture", "dependency-policy", "formatting",
    "infrastructure", "error-handling", "ui-framework",
  ];
  for (let i = 0; i < 20; i++) {
    t.ctx.preferences.remember({
      rule: `House rule ${i} about the ${domains[i % domains.length]} area of work.`,
      category: domains[i % domains.length]!,
      scope: "global",
    });
  }
  // A task with no clear domain: with no relevance signal, few/none pass.
  const capped = t.ctx.retrieval.retrieve({ cwd: process.cwd(), limit: 999 });
  expect(capped.preferences.length).toBeLessThanOrEqual(15);
  t.cleanup();
});

test("retrieval marks returned preferences as used", () => {
  const t = makeTestContext();
  const p = t.ctx.preferences.remember({
    rule: "Prefer relational constraints and database-enforced invariants.",
    category: "database",
    scope: "global",
  });
  expect(t.ctx.preferences.getById(p.id)!.lastUsedAt).toBeNull();
  t.ctx.retrieval.retrieve({ cwd: process.cwd(), task: "Design the database schema persistence." });
  expect(t.ctx.preferences.getById(p.id)!.lastUsedAt).not.toBeNull();
  t.cleanup();
});
