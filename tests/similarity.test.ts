import { test, expect } from "bun:test";
import { JaccardSimilarity, coverageScore } from "../src/core/preferences/similarity.ts";

const sim = new JaccardSimilarity();

test("similar rules score high, unrelated rules score low", () => {
  const a = "Prefer extending existing domain services before creating parallel service layers.";
  const b = "Extend existing domain services instead of creating parallel service layers.";
  const c = "Write unit tests for every bug fix.";
  expect(sim.score(a, b)).toBeGreaterThan(0.6);
  expect(sim.score(a, c)).toBeLessThan(0.2);
});

test("normalize is stable regardless of word order and punctuation", () => {
  expect(sim.normalize("Prefer, existing dependencies!")).toBe(
    sim.normalize("dependencies existing prefer"),
  );
});

test("coverageScore rewards a task covered by a rule", () => {
  const task = "date formatting helper";
  const relevant = "Prefer writing small date and formatting helper utilities.";
  const irrelevant = "Deploy using blue-green infrastructure.";
  expect(coverageScore(task, relevant, sim)).toBeGreaterThan(
    coverageScore(task, irrelevant, sim),
  );
});
