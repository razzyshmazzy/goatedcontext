/**
 * The frozen first-party developer-memory dataset (spec §5, §51, §60).
 *
 * Scenarios are curated by hand, not generated from one template (spec §52): wording,
 * preference type, task framing, language, implicitness, and interference all vary, and
 * no package-manager probe contains the phrase "package manager". Each scenario is
 * validated against the schema + anti-cheating rules at load; an invalid dataset throws
 * immediately rather than silently scoring garbage.
 *
 * Split (spec §51): `dev` scenarios are for iterating on the HARNESS; `heldout` scenarios
 * exist to detect accidental overfitting and must never drive product tuning. Production
 * ctx contains NO scenario-specific logic; this split just makes drift obvious.
 */
import { ScenarioSchema, validateScenario, type Category, type Scenario, type ScenarioInput } from "../src/schema.ts";
import { explicitDefaults } from "./explicit-defaults.ts";
import { repoScoped } from "./repo-scoped.ts";
import { conditional } from "./conditional.ts";
import { corrections } from "./corrections.ts";
import { implicit } from "./implicit.ts";
import { negativeAbstention } from "./negative-abstention.ts";
import { poisoning } from "./poisoning.ts";
import { conflictPrecedence } from "./conflict-precedence.ts";
import { reinforcement } from "./reinforcement.ts";

const RAW: ScenarioInput[] = [
  ...explicitDefaults,
  ...repoScoped,
  ...conditional,
  ...corrections,
  ...implicit,
  ...negativeAbstention,
  ...poisoning,
  ...conflictPrecedence,
  ...reinforcement,
];

/** Parse + structurally validate the whole dataset, throwing a precise error on any fault. */
function loadScenarios(): Scenario[] {
  const seen = new Set<string>();
  const out: Scenario[] = [];
  for (const raw of RAW) {
    const parsed = ScenarioSchema.parse(raw); // zod shape + defaults
    if (seen.has(parsed.id)) throw new Error(`duplicate scenario id: ${parsed.id}`);
    seen.add(parsed.id);
    const problems = validateScenario(parsed);
    if (problems.length > 0) {
      throw new Error(`scenario "${parsed.id}" invalid:\n  - ${problems.join("\n  - ")}`);
    }
    out.push(parsed);
  }
  return out;
}

export const ALL_SCENARIOS: Scenario[] = loadScenarios();

export function devScenarios(): Scenario[] {
  return ALL_SCENARIOS.filter((s) => s.split === "dev");
}

export function heldoutScenarios(): Scenario[] {
  return ALL_SCENARIOS.filter((s) => s.split === "heldout");
}

export function byCategory(category: Category): Scenario[] {
  return ALL_SCENARIOS.filter((s) => s.category === category);
}

export function byId(id: string): Scenario | undefined {
  return ALL_SCENARIOS.find((s) => s.id === id);
}

/** Scenarios the mock adapter can score deterministically (used by the demo). These map
 * to the mock's four built-in dimensions; others require a real agent and the mock
 * reports them `unsupported`. */
export const DEMO_SCENARIO_IDS = [
  "bun-add-zod",
  "vitest-write-tests",
  "typescript-quick-script",
  "correction-vitest-to-jest",
  "poison-readme-prefers-npm",
] as const;

export function demoScenarios(): Scenario[] {
  return DEMO_SCENARIO_IDS.map((id) => byId(id)).filter((s): s is Scenario => Boolean(s));
}

export function datasetCounts(): { total: number; byCategory: Record<string, number>; bySplit: Record<string, number> } {
  const byCat: Record<string, number> = {};
  const bySplit: Record<string, number> = {};
  for (const s of ALL_SCENARIOS) {
    byCat[s.category] = (byCat[s.category] ?? 0) + 1;
    bySplit[s.split] = (bySplit[s.split] ?? 0) + 1;
  }
  return { total: ALL_SCENARIOS.length, byCategory: byCat, bySplit };
}
