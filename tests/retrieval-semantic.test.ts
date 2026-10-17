/**
 * Retrieval-engine semantic behaviors (engine pass, spec §2–§8). Fast and in-process
 * (no spawn) so they run in the main `bun test`; the black-box corpus
 * (benchmarks/autonomous-pull/semantic-corpus.ts) covers the aggregate metrics.
 *
 * Guards the three engine changes: morphology (derived-form ↔ root), domain-abstracted
 * recall of proper-noun-only memories, and the explanatory-intent gate that stops a
 * conceptual question from injecting a stored preference about the same entity.
 */
import { test, expect, describe } from "bun:test";
import { makeTestContext } from "./helpers.ts";
import { stem } from "../src/core/preferences/analysis.ts";
import { isExplanatoryIntent } from "../src/core/signals/domains.ts";

function retrieveRules(task: string, seedRules: string[]): string[] {
  const t = makeTestContext();
  try {
    for (const rule of seedRules) t.ctx.preferences.remember({ rule, scope: "global" });
    const res = t.ctx.retrieval.retrieve({ cwd: process.cwd(), task, track: false });
    return res.preferences.map((p) => p.rule.toLowerCase());
  } finally {
    t.cleanup();
  }
}

describe("morphology — derived forms stem to the same root", () => {
  test("verb/noun pairs unify", () => {
    for (const [a, b] of [
      ["deploy", "deployment"],
      ["persist", "persistence"],
      ["configure", "configuration"],
      ["cache", "caching"],
      ["log", "logging"],
      ["test", "testing"],
    ]) {
      expect(stem(a)).toBe(stem(b));
    }
  });

  test("short tokens and distinct roots are NOT over-collapsed", () => {
    expect(stem("io")).toBe("io");
    expect(stem("db")).toBe("db");
    // genuinely different concepts must not collide
    expect(stem("database")).not.toBe(stem("deploy"));
    expect(stem("testing")).not.toBe(stem("caching"));
  });

  test("a noun-phrased query retrieves a verb-phrased deployment rule", () => {
    const rules = retrieveRules("deployment convention for this repo", [
      "Deploy this app to Fly.io.",
      "Use Vitest for unit tests.",
    ]);
    expect(rules.some((r) => r.includes("fly.io"))).toBe(true);
  });
});

describe("proper-noun recall via domain abstraction", () => {
  test("an oblique query retrieves a product-only memory without naming the product", () => {
    const rules = retrieveRules("add a job queue", ["Use BullMQ for background jobs."]);
    expect(rules.some((r) => r.includes("bullmq"))).toBe(true);
  });

  test("authentication is a recognized decision domain (auth ↔ authentication)", () => {
    const rules = retrieveRules("add login and authentication", ["Keep auth server-side with session cookies."]);
    expect(rules.some((r) => r.includes("auth"))).toBe(true);
  });
});

describe("explanatory-intent gate — precision", () => {
  test("isExplanatoryIntent fires on conceptual questions, not decision/implementation ones", () => {
    for (const q of [
      "what is a queue?",
      "explain how Redis eviction works",
      "what is structured logging?",
      "how does OAuth work?",
    ]) {
      expect(isExplanatoryIntent(q)).toBe(true);
    }
    for (const q of [
      "what caching do we use?", // ownership → decision-seeking
      "add a job queue", // implementation
      "set up caching", // implementation
      "what did we decide for auth?", // decision-seeking
      "what do you call me", // naming (ownership: you/me)
    ]) {
      expect(isExplanatoryIntent(q)).toBe(false);
    }
  });

  test("a conceptual question does NOT surface a stored preference about the same entity", () => {
    expect(retrieveRules("explain how Redis eviction works", ["Prefer Redis for caching."]).some((r) => r.includes("redis"))).toBe(false);
    expect(retrieveRules("what is a queue?", ["Use BullMQ for background jobs."]).some((r) => r.includes("bullmq"))).toBe(false);
    expect(retrieveRules("explain Postgres MVCC", ["Prefer Postgres in production."]).some((r) => r.includes("postgres"))).toBe(false);
  });

  test("a decision-seeking question DOES surface the preference (gate is not over-broad)", () => {
    expect(retrieveRules("what caching do we use here?", ["Prefer Redis for caching."]).some((r) => r.includes("redis"))).toBe(true);
  });
});
