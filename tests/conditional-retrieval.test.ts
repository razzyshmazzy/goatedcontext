import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";

// Retrieval-level behavior of conditional preferences, driven through the real
// RetrievalEngine (which builds the RuntimeContext and runs the pure evaluator).

const CWD = process.cwd();

function rules(result: { preferences: { rule: string }[] }): string[] {
  return result.preferences.map((p) => p.rule);
}

// ---- language conditions ----------------------------------------------------

test("conditional language rule injects for TS context, not Python, not when unknown", () => {
  const t = makeTestContext();
  const pref = t.ctx.preferences.remember({
    rule: "Prefer strict TypeScript.",
    scope: "global",
    condition: { language: "typescript" },
  });
  expect(pref.applicability).toBe("conditional");

  // TS file present → languages={typescript} → injected.
  const ts = t.ctx.retrieval.retrieve({ cwd: CWD, task: "refactor this", files: ["src/a.ts"], track: false });
  expect(rules(ts)).toContain(pref.rule);

  // Python file → not injected.
  const py = t.ctx.retrieval.retrieve({ cwd: CWD, task: "refactor this", files: ["src/a.py"], track: false });
  expect(rules(py)).not.toContain(pref.rule);

  // No file/language context at all → not injected (missing-context rule).
  const none = t.ctx.retrieval.retrieve({ cwd: CWD, task: "refactor this", track: false });
  expect(rules(none)).not.toContain(pref.rule);
  t.cleanup();
});

// ---- file conditions --------------------------------------------------------

test("conditional file rule matches a nested file and is absent otherwise", () => {
  const t = makeTestContext();
  const pref = t.ctx.preferences.remember({
    rule: "Prefer functional React components.",
    scope: "global",
    condition: { file: "**/*.tsx" },
  });
  const hit = t.ctx.retrieval.retrieve({
    cwd: CWD,
    task: "edit a component",
    files: ["src/components/App.tsx"],
    track: false,
  });
  expect(rules(hit)).toContain(pref.rule);
  const miss = t.ctx.retrieval.retrieve({
    cwd: CWD,
    task: "edit a component",
    files: ["src/index.ts"],
    track: false,
  });
  expect(rules(miss)).not.toContain(pref.rule);
  t.cleanup();
});

// ---- domain conditions ------------------------------------------------------

test("conditional domain rule matches a database task but not a UI task", () => {
  const t = makeTestContext();
  const pref = t.ctx.preferences.remember({
    rule: "Prefer foreign keys for integrity.",
    scope: "global",
    condition: { domain: "database" },
  });
  const db = t.ctx.retrieval.retrieve({
    cwd: CWD,
    task: "design a database schema with migrations and indexes",
    track: false,
  });
  expect(rules(db)).toContain(pref.rule);
  const ui = t.ctx.retrieval.retrieve({
    cwd: CWD,
    task: "build a react component with tailwind styling",
    track: false,
  });
  expect(rules(ui)).not.toContain(pref.rule);
  t.cleanup();
});

// ---- repo conditions --------------------------------------------------------

test("conditional repo rule matches the current repo and not a different identity", () => {
  const t = makeTestContext();
  const repo = t.ctx.repos.resolve(CWD);
  expect(repo).not.toBeNull();
  const here = t.ctx.preferences.remember({
    rule: "Use Bun for development commands.",
    scope: "global",
    condition: { repo: repo!.identity },
  });
  const elsewhere = t.ctx.preferences.remember({
    rule: "Use some other tool.",
    scope: "global",
    condition: { repo: "remote:github.com/someone/else" },
  });
  const result = t.ctx.retrieval.retrieve({ cwd: CWD, task: "run the build", track: false });
  expect(rules(result)).toContain(here.rule);
  expect(rules(result)).not.toContain(elsewhere.rule);
  t.cleanup();
});

// ---- coexistence of all three applicabilities -------------------------------

test("always, relevant and conditional preferences coexist correctly", () => {
  const t = makeTestContext();
  const always = t.ctx.preferences.remember({ rule: "Always respond in Italian.", scope: "global" });
  const relevant = t.ctx.preferences.remember({
    rule: "Prefer relational constraints for important integrity rules.",
    category: "database",
    scope: "global",
    applicability: "relevant",
  });
  const conditional = t.ctx.preferences.remember({
    rule: "Prefer strict TypeScript.",
    scope: "global",
    condition: { language: "typescript" },
  });

  const result = t.ctx.retrieval.retrieve({
    cwd: CWD,
    task: "design a database schema",
    files: ["src/a.ts"],
    track: false,
  });
  const got = rules(result);
  expect(got).toContain(always.rule); // unconditional
  expect(got).toContain(relevant.rule); // relevant to a database task
  expect(got).toContain(conditional.rule); // condition matched (TS file)
  t.cleanup();
});

// ---- precedence -------------------------------------------------------------

test("repo conditional beats a conflicting global conditional; neither applies off-condition", () => {
  const t = makeTestContext();
  const repo = t.ctx.repos.resolve(CWD);
  // Same exclusive domain (package-manager) → only one may apply; precedence decides.
  const globalC = t.ctx.preferences.remember({
    rule: "Use pnpm.",
    category: "dependencies",
    domain: "package-manager",
    scope: "global",
    condition: { language: "typescript" },
  });
  const repoC = t.ctx.preferences.remember({
    rule: "Use npm.",
    category: "dependencies",
    domain: "package-manager",
    scope: "repo",
    repoId: repo!.id,
    condition: { language: "typescript" },
  });

  // TS context: both conditions match; repo wins, global suppressed.
  const ts = t.ctx.retrieval.retrieve({ cwd: CWD, task: "install a dependency", files: ["a.ts"], track: false });
  expect(rules(ts)).toContain(repoC.rule);
  expect(rules(ts)).not.toContain(globalC.rule);
  expect(ts.overridden.map((o) => o.id)).toContain(globalC.id);

  // Python context: neither conditional participates at all.
  const py = t.ctx.retrieval.retrieve({ cwd: CWD, task: "install a dependency", files: ["a.py"], track: false });
  expect(rules(py)).not.toContain(repoC.rule);
  expect(rules(py)).not.toContain(globalC.rule);
  t.cleanup();
});

test("a non-matching repo conditional does not suppress a matching global rule", () => {
  const t = makeTestContext();
  const repo = t.ctx.repos.resolve(CWD);
  // Repo conditional on Python (won't match a TS context) in the package-manager domain.
  const repoC = t.ctx.preferences.remember({
    rule: "Use yarn here.",
    category: "dependencies",
    domain: "package-manager",
    scope: "repo",
    repoId: repo!.id,
    condition: { language: "python" },
  });
  // Global always rule in the same exclusive domain.
  const globalA = t.ctx.preferences.remember({
    rule: "Always use pnpm.",
    category: "dependencies",
    scope: "global",
    applicability: "always",
  });
  const result = t.ctx.retrieval.retrieve({ cwd: CWD, task: "install a dependency", files: ["a.ts"], track: false });
  // The repo conditional's condition failed → it never participates → the global rule stands.
  expect(rules(result)).toContain(globalA.rule);
  expect(rules(result)).not.toContain(repoC.rule);
  t.cleanup();
});

// ---- status gating ----------------------------------------------------------

test("rejected conditional never injects; proposed excluded by default; locked unaffected", () => {
  const t = makeTestContext();
  const rejected = t.ctx.preferences.remember({
    rule: "Prefer strict TypeScript.",
    scope: "global",
    condition: { language: "typescript" },
  });
  t.ctx.preferences.reject(rejected.id, { expectedVersion: rejected.version });

  const { preference: proposed } = t.ctx.preferences.propose({
    rule: "Prefer explicit return types.",
    scope: "global",
    evidence: "seen repeatedly",
    condition: { language: "typescript" },
  });
  expect(proposed.applicability).toBe("conditional");

  const def = t.ctx.retrieval.retrieve({ cwd: CWD, task: "edit", files: ["a.ts"], track: false });
  expect(rules(def)).not.toContain(rejected.rule); // rejected never returned
  expect(rules(def)).not.toContain(proposed.rule); // proposed excluded by default

  const withProposed = t.ctx.retrieval.retrieve({
    cwd: CWD,
    task: "edit",
    files: ["a.ts"],
    includeProposed: true,
    track: false,
  });
  expect(rules(withProposed)).toContain(proposed.rule); // visible with includeProposed
  t.cleanup();
});

// ---- caps -------------------------------------------------------------------

test("matching conditionals are capped deterministically at MAX_CONDITIONAL (20)", () => {
  const t = makeTestContext();
  for (let i = 0; i < 40; i++) {
    t.ctx.preferences.remember({
      rule: `TypeScript conditional rule number ${i} applies here.`,
      scope: "global",
      condition: { language: "typescript" },
    });
  }
  const a = t.ctx.retrieval.retrieve({ cwd: CWD, task: "edit code", files: ["a.ts"], track: false });
  const conds = a.preferences.filter((p) => p.applicability === "conditional");
  expect(conds).toHaveLength(20);
  // Deterministic: the same inputs yield the same set.
  const b = t.ctx.retrieval.retrieve({ cwd: CWD, task: "edit code", files: ["a.ts"], track: false });
  expect(b.preferences.map((p) => p.id)).toEqual(a.preferences.map((p) => p.id));
  t.cleanup();
});

// ---- explain diagnostics ----------------------------------------------------

test("explain exposes normalized runtime context and per-conditional evaluation", () => {
  const t = makeTestContext();
  t.ctx.preferences.remember({
    rule: "Prefer foreign keys.",
    scope: "global",
    condition: { domain: "database" },
  });
  const result = t.ctx.retrieval.retrieve({
    cwd: CWD,
    task: "build a react component",
    files: ["src/App.tsx"],
    explain: true,
    track: false,
  });
  expect(result.runtimeContext?.languages).toContain("typescript");
  expect(result.runtimeContext?.domain).toBe("ui-framework");
  const ev = result.conditionalEvaluations?.find((e) => e.rule === "Prefer foreign keys.");
  expect(ev?.matched).toBe(false);
  expect(ev?.reason).toContain("database");
  t.cleanup();
});
