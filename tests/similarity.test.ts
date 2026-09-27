import { test, expect } from "bun:test";
import { JaccardSimilarity } from "../src/core/preferences/similarity.ts";
import {
  polarity,
  subjectKey,
  inferDomains,
  inferPrimaryDomain,
  isExclusiveDomain,
} from "../src/core/preferences/analysis.ts";

const sim = new JaccardSimilarity();

test("subject similarity is high for same-subject rules, low for unrelated", () => {
  const a = "Prefer extending existing domain services before creating parallel service layers.";
  const b = "Extend existing domain services instead of creating parallel service layers.";
  const c = "Write unit tests for every bug fix.";
  expect(sim.score(a, b)).toBeGreaterThan(0.6);
  expect(sim.score(a, c)).toBeLessThan(0.2);
});

test("subject key ignores polarity and generic verbs", () => {
  // "Use Redis" and "Never use Redis" share the SAME subject.
  expect(subjectKey("Use Redis.")).toBe(subjectKey("Never use Redis."));
});

test("polarity detects positive, negative and neutral directives", () => {
  expect(polarity("Use Redis.")).toBe("positive");
  expect(polarity("Never use Redis.")).toBe("negative");
  expect(polarity("Prefer helper functions.")).toBe("positive");
  expect(polarity("Avoid helper functions unless necessary.")).toBe("negative");
  expect(polarity("Always use pnpm.")).toBe("positive");
  expect(polarity("Do not use pnpm in this repository.")).toBe("negative");
  expect(polarity("Settlement records are stored per day.")).toBe("neutral");
});

test("benign 'non-' words are not treated as negation", () => {
  expect(polarity("Prefer non-blocking IO for network calls.")).toBe("positive");
});

test("domain inference maps text to decision domains", () => {
  expect(inferPrimaryDomain("This repository must use npm.")).toBe("package-manager");
  expect(inferPrimaryDomain("Prefer pnpm for JavaScript projects.")).toBe("package-manager");
  expect(inferPrimaryDomain("This repository uses PostgreSQL.")).toBe("database");
  expect(inferPrimaryDomain("This repository uses SQLite locally.")).toBe("database");
  const uiDomains = inferDomains("Change the settings button color.");
  expect(uiDomains.has("ui-framework")).toBe(true);
  expect(uiDomains.has("database")).toBe(false);
});

test("exclusive domains are flagged", () => {
  expect(isExclusiveDomain("package-manager")).toBe(true);
  expect(isExclusiveDomain("database")).toBe(true);
  expect(isExclusiveDomain("testing")).toBe(false);
  expect(isExclusiveDomain(null)).toBe(false);
});
