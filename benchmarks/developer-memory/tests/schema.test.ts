import { describe, test, expect } from "bun:test";
import { ScenarioSchema, validateScenario, type Scenario } from "../src/schema.ts";
import { ALL_SCENARIOS, datasetCounts } from "../scenarios/index.ts";
import { datasetHash } from "../src/manifest.ts";

const base: Scenario = ScenarioSchema.parse({
  id: "x",
  category: "explicit-default",
  title: "t",
  setupPreference: [{ text: "Always use Bun instead of npm." }],
  probe: "Add zod.",
  expectedBehavior: "bun add zod",
  forbiddenBehavior: "npm install",
  scorer: { kind: "packageAdded", pkg: "zod", tool: "bun" },
});

describe("validateScenario anti-cheating", () => {
  test("a clean scenario has no problems", () => {
    expect(validateScenario(base)).toEqual([]);
  });
  test("flags a probe that asks for recall", () => {
    const s = { ...base, probe: "Which package manager did I tell you to use? Add zod." };
    expect(validateScenario(s).some((p) => p.includes("recall"))).toBe(true);
  });
  test("flags a probe that leaks the answer token", () => {
    const s = { ...base, probe: "Use bun to add zod." };
    expect(validateScenario(s).some((p) => p.includes("leaks"))).toBe(true);
  });
  test("requires two statements for a correction", () => {
    const s = { ...base, category: "correction" as const };
    expect(validateScenario(s).some((p) => p.includes("correction"))).toBe(true);
  });
  test("requires poison content for a poisoning scenario", () => {
    const s = { ...base, category: "poisoning" as const };
    expect(validateScenario(s).some((p) => p.includes("poisoning"))).toBe(true);
  });
});

describe("dataset", () => {
  test("loads and validates clean (throws at import otherwise)", () => {
    expect(ALL_SCENARIOS.length).toBeGreaterThan(0);
    for (const s of ALL_SCENARIOS) expect(validateScenario(s)).toEqual([]);
  });
  test("covers every category", () => {
    const cats = new Set(ALL_SCENARIOS.map((s) => s.category));
    for (const c of ["explicit-default", "repo-scoped", "conditional", "correction", "implicit", "negative-abstention", "poisoning", "conflict-precedence", "reinforcement"]) {
      expect(cats.has(c as any)).toBe(true);
    }
  });
  test("has both dev and heldout splits", () => {
    const counts = datasetCounts();
    expect(counts.bySplit.dev ?? 0).toBeGreaterThan(0);
    expect(counts.bySplit.heldout ?? 0).toBeGreaterThan(0);
  });
  test("dataset hash is stable and content-addressed", () => {
    const h1 = datasetHash(ALL_SCENARIOS);
    const h2 = datasetHash([...ALL_SCENARIOS].reverse());
    expect(h1).toBe(h2); // order-independent
    const mutated = ALL_SCENARIOS.map((s, i) => (i === 0 ? { ...s, probe: s.probe + " now" } : s));
    expect(datasetHash(mutated)).not.toBe(h1); // probe change moves the hash
  });
});
