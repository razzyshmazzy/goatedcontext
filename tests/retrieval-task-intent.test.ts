import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";

/**
 * Regression tests for the task-intent relevance fix (0.4.x): `rank()` now consults the
 * canonical task-domain set (classifier ∪ alias ∪ intent triggers) — the same inference
 * that already gates signal surfacing — in addition to the raw classifier domains. This
 * closes the gap where project-bootstrapping / intent-worded tasks ("initialize this
 * project", "set up dependencies") failed to surface a legitimately-relevant preference.
 *
 * The change is purely ADDITIVE (it only adds domain matches, never removes one), so the
 * false-positive guards below must still hold: an unrelated task surfaces nothing.
 */
function rules(result: { preferences: { rule: string }[] }): string[] {
  return result.preferences.map((p) => p.rule);
}

const PM = "Use pnpm as the package manager.";

test("an init/scaffold task surfaces a package-manager preference via intent triggers", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({ rule: PM, category: "dependencies", scope: "global" });
  const result = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    task: "Initialize this project and set up its dependencies.",
  });
  expect(rules(result)).toContain(PM);
  t.cleanup();
});

test("an explicit tests task surfaces a testing preference (no framework named)", () => {
  const t = makeTestContext();
  const v = "I like Vitest for testing.";
  t.ctx.preferences.remember({ rule: v, category: "testing", scope: "global" });
  const result = t.ctx.retrieval.retrieve({
    cwd: process.cwd(),
    task: "The parser module has no tests yet. Add some.",
  });
  expect(rules(result)).toContain(v);
  t.cleanup();
});

test("false-positive guard: an unrelated task surfaces NO package-manager preference", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({ rule: PM, category: "dependencies", scope: "global" });
  for (const task of [
    "Explain what TCP slow start is and when it matters.",
    "Rename the greeting constant to salutation.",
  ]) {
    const result = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task });
    expect(rules(result)).not.toContain(PM);
  }
  t.cleanup();
});

// ---- F3: dependency-acquisition intent delivers the package-manager pref ----

test("a terse 'add <pkg>' task surfaces a package-manager preference (F3)", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({ rule: PM, category: "dependencies", scope: "global" });
  for (const task of [
    "Add uuid to generate ids.", // no package manager named; names a package
    "Pull in dayjs so we can format timestamps.",
    "Add nanoid.",
    "Install the redis client.",
  ]) {
    const result = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task });
    expect(rules(result)).toContain(PM);
  }
  t.cleanup();
});

test("F3 false-positive guard: non-install 'add X' work surfaces NO package-manager pref", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({ rule: PM, category: "dependencies", scope: "global" });
  for (const task of [
    "Add a button to the settings page.",
    "Add logging to the request handler.",
    "Add validation for the signup form.",
    "Pull in the latest changes from main.",
  ]) {
    const result = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task });
    expect(rules(result)).not.toContain(PM);
  }
  t.cleanup();
});
