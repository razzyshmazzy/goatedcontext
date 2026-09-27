import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";

test("empty rule is rejected and nothing is written", () => {
  const t = makeTestContext();
  expect(() =>
    t.ctx.preferences.remember({ rule: "", category: "general", scope: "global" }),
  ).toThrow();
  expect(t.ctx.preferences.list().length).toBe(0);
  t.cleanup();
});

test("whitespace-only rule is rejected", () => {
  const t = makeTestContext();
  expect(() =>
    t.ctx.preferences.remember({ rule: "   \t  ", category: "general", scope: "global" }),
  ).toThrow();
  expect(t.ctx.preferences.list().length).toBe(0);
  t.cleanup();
});

test("unsupported scope is rejected and nothing is written", () => {
  const t = makeTestContext();
  expect(() =>
    // @ts-expect-error deliberately invalid scope
    t.ctx.preferences.remember({ rule: "some rule", category: "general", scope: "bogus" }),
  ).toThrow();
  expect(t.ctx.preferences.list().length).toBe(0);
  t.cleanup();
});

test("unknown explicit domain is rejected", () => {
  const t = makeTestContext();
  expect(() =>
    t.ctx.preferences.remember({
      rule: "some rule",
      category: "general",
      scope: "global",
      domain: "not-a-real-domain",
    }),
  ).toThrow();
  expect(t.ctx.preferences.list().length).toBe(0);
  t.cleanup();
});

test("propose requires non-empty evidence", () => {
  const t = makeTestContext();
  expect(() =>
    t.ctx.preferences.propose({ rule: "a real rule", category: "general", scope: "global", evidence: "  " }),
  ).toThrow();
  t.cleanup();
});

test("category is normalized to lowercase", () => {
  const t = makeTestContext();
  const p = t.ctx.preferences.remember({ rule: "a rule", category: "DataBase", scope: "global" });
  expect(p.category).toBe("database");
  t.cleanup();
});

test("invalid environment name is rejected", () => {
  const t = makeTestContext();
  expect(() => t.ctx.environments.add({ name: "bad name!" })).toThrow();
  expect(t.ctx.environments.list().length).toBe(0);
  t.cleanup();
});
