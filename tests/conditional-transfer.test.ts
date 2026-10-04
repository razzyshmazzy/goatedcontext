import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";
import { exportData, importData } from "../src/core/transfer/transfer.ts";
import { conditionToCanonicalJson } from "../src/core/preferences/conditions.ts";

// Export/import behavior specific to conditional preferences.

test("conditional preferences round-trip through export/import", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({
    rule: "Prefer strict TypeScript.",
    scope: "global",
    condition: { all: [{ language: "typescript" }, { file: "src/**/*.ts" }] },
  });
  const bundle = exportData(t.ctx);
  const exported = bundle.preferences.find((p) => p.rule === "Prefer strict TypeScript.")!;
  expect(exported.applicability).toBe("conditional");
  expect(exported.condition).toEqual({
    all: [{ file: "src/**/*.ts" }, { language: "typescript" }],
  });

  const t2 = makeTestContext();
  importData(t2.ctx, bundle);
  const imported = t2.ctx.preferences.list().find((p) => p.rule === "Prefer strict TypeScript.")!;
  expect(imported.applicability).toBe("conditional");
  expect(conditionToCanonicalJson(imported.condition!)).toBe(
    conditionToCanonicalJson({ all: [{ language: "typescript" }, { file: "src/**/*.ts" }] }),
  );
  t.cleanup();
  t2.cleanup();
});

test("import is idempotent and condition equality ignores JSON ordering", () => {
  const t = makeTestContext();

  const bundle = {
    schema: "ctx-export" as const,
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    repos: [],
    preferences: [
      {
        rule: "Prefer explicit return types.",
        category: "general",
        domain: null,
        polarity: "neutral" as const,
        scope: "global" as const,
        status: "approved" as const,
        applicability: "conditional" as const,
        condition: { all: [{ language: "typescript" }, { file: "src/**/*.ts" }] },
        confidence: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repoIdentity: null,
        evidence: [],
      },
    ],
  };

  const first = importData(t.ctx, bundle);
  expect(first.imported).toBe(1);

  // Re-import the SAME preference but with the condition members reordered: the
  // canonical dedup key is identical, so it must NOT create a duplicate.
  const reordered = structuredClone(bundle);
  reordered.preferences[0]!.condition = { all: [{ file: "src/**/*.ts" }, { language: "typescript" }] };
  const second = importData(t.ctx, reordered);
  expect(second.imported).toBe(0); // idempotent, no duplicate from key ordering
  expect(t.ctx.preferences.list()).toHaveLength(1);
  t.cleanup();
});

test("old bundles without a condition field import as relevant/always", () => {
  const t = makeTestContext();
  const legacy = {
    schema: "ctx-export",
    version: 1,
    exportedAt: "2020-01-01T00:00:00.000Z",
    repos: [],
    preferences: [
      {
        rule: "Legacy relevant rule.",
        category: "general",
        domain: null,
        polarity: "neutral",
        scope: "global",
        status: "approved",
        confidence: 1,
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
        repoIdentity: null,
        evidence: [],
      },
    ],
  };
  const summary = importData(t.ctx, legacy);
  expect(summary.imported).toBe(1);
  const p = t.ctx.preferences.list()[0]!;
  expect(p.applicability).toBe("relevant");
  expect(p.condition).toBeNull();
  t.cleanup();
});

test("malformed bundles are rejected: conditional without a condition, and relevant WITH one", () => {
  const t = makeTestContext();
  const base = {
    schema: "ctx-export",
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    repos: [],
  };

  const conditionalNoCondition = {
    ...base,
    preferences: [
      {
        rule: "Bad conditional.",
        category: "general",
        domain: null,
        polarity: "neutral",
        scope: "global",
        status: "approved",
        applicability: "conditional",
        confidence: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repoIdentity: null,
        evidence: [],
      },
    ],
  };
  expect(() => importData(t.ctx, conditionalNoCondition)).toThrow();

  const relevantWithCondition = {
    ...base,
    preferences: [
      {
        rule: "Bad relevant.",
        category: "general",
        domain: null,
        polarity: "neutral",
        scope: "global",
        status: "approved",
        applicability: "relevant",
        condition: { language: "typescript" },
        confidence: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repoIdentity: null,
        evidence: [],
      },
    ],
  };
  expect(() => importData(t.ctx, relevantWithCondition)).toThrow();

  // Neither malformed bundle wrote anything.
  expect(t.ctx.preferences.list()).toHaveLength(0);
  t.cleanup();
});
