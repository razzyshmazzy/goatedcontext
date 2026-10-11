/**
 * Regression test for the v1.1 sandbox-metadata leak (harness scoring bug).
 *
 * The sandbox git remote is copied into package.json by `npm init`, and content-scanning
 * scorers read file contents. If the remote embedded the scenario id (e.g. `cond-sqlite-…`),
 * a forbidden/preferred token could false-match from repo METADATA alone — a postgres
 * solution once failed a `noForbiddenChoice:["sqlite"]` scorer because the id contained
 * "sqlite". The fix makes the sandbox slug an opaque hash. This test guards that invariant:
 * NO scenario's sandbox slug may contain ANY tool/choice token used anywhere in the dataset.
 */
import { describe, test, expect } from "bun:test";
import { sandboxSlug } from "../src/conditions.ts";
import { ALL_SCENARIOS } from "../scenarios/index.ts";

const TOOL_TOKENS = [
  "bun", "npm", "pnpm", "yarn", "vitest", "jest", "sqlite", "postgres", "mysql",
  "react", "tailwind", "express", "typescript", "javascript",
];

describe("sandbox slug neutrality", () => {
  test("slug is an opaque hex hash", () => {
    expect(sandboxSlug("cond-sqlite-prototype-nomatch")).toMatch(/^s[0-9a-f]{12}$/);
  });

  test("no scenario's slug leaks a tool/choice token", () => {
    for (const s of ALL_SCENARIOS) {
      const slug = sandboxSlug(s.id).toLowerCase();
      const leaked = TOOL_TOKENS.find((t) => slug.includes(t));
      expect(leaked, `slug for ${s.id} leaked "${leaked}"`).toBeUndefined();
    }
  });

  test("slugs are stable and distinct per id", () => {
    expect(sandboxSlug("a")).toBe(sandboxSlug("a"));
    expect(sandboxSlug("a")).not.toBe(sandboxSlug("b"));
    const slugs = new Set(ALL_SCENARIOS.map((s) => sandboxSlug(s.id)));
    expect(slugs.size).toBe(ALL_SCENARIOS.length);
  });
});
