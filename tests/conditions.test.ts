import { test, expect } from "bun:test";
import {
  parseCondition,
  canonicalizeCondition,
  conditionToCanonicalJson,
  conditionFromJson,
  compactCondition,
  renderConditionLines,
  buildWhenCondition,
  parseWhenFlag,
  type Condition,
} from "../src/core/preferences/conditions.ts";
import { evaluateCondition } from "../src/core/retrieval/evaluate.ts";
import type { RuntimeContext } from "../src/core/retrieval/runtime-context.ts";
import { normalizeLanguage, inferLanguagesFromFiles } from "../src/core/preferences/languages.ts";
import { matchGlob } from "../src/utils/glob.ts";

// ---- test helpers -----------------------------------------------------------

function rc(partial: Partial<RuntimeContext>): RuntimeContext {
  return {
    cwd: "/tmp",
    repo: null,
    task: null,
    files: [],
    languages: new Set<string>(),
    domain: null,
    ...partial,
  };
}

const identityResolver = (v: string) => v; // tests pass canonical identities already

// ---- languages --------------------------------------------------------------

test("language: canonical + aliases normalize; unknown → null", () => {
  expect(normalizeLanguage("ts")).toBe("typescript");
  expect(normalizeLanguage("TypeScript")).toBe("typescript");
  expect(normalizeLanguage("py")).toBe("python");
  expect(normalizeLanguage("c++")).toBe("cpp");
  expect(normalizeLanguage("c#")).toBe("csharp");
  expect(normalizeLanguage("cs")).toBe("csharp");
  expect(normalizeLanguage("golang")).toBe("go");
  expect(normalizeLanguage("cobol")).toBeNull();
  expect(normalizeLanguage("")).toBeNull();
});

test("language: inference is by file extension only", () => {
  expect([...inferLanguagesFromFiles(["src/App.tsx", "x.ts"])]).toEqual(["typescript"]);
  expect([...inferLanguagesFromFiles(["a.py", "b.rs", "c.go"]).values()].sort()).toEqual([
    "go",
    "python",
    "rust",
  ]);
  expect([...inferLanguagesFromFiles(["README", "Makefile"])]).toEqual([]);
});

// ---- glob -------------------------------------------------------------------

test("glob: ** crosses segments, * does not", () => {
  expect(matchGlob("**/*.tsx", "src/components/App.tsx")).toBe(true);
  expect(matchGlob("**/*.tsx", "App.tsx")).toBe(true);
  expect(matchGlob("src/**/*.ts", "src/a/b/c.ts")).toBe(true);
  expect(matchGlob("src/**/*.ts", "src/c.ts")).toBe(true);
  expect(matchGlob("tests/**", "tests/a/b.ts")).toBe(true);
  expect(matchGlob("*.md", "README.md")).toBe(true);
  expect(matchGlob("*.md", "docs/README.md")).toBe(false); // * does not cross /
  expect(matchGlob("**/*.tsx", "src/app.ts")).toBe(false);
});

test("glob: Windows backslashes normalize to forward slashes", () => {
  expect(matchGlob("src/**/*.ts", "src\\components\\App.ts")).toBe(true);
});

// ---- AST validation ---------------------------------------------------------

test("AST: valid leaves parse & normalize", () => {
  expect(parseCondition({ language: "ts" })).toEqual({ language: "typescript" });
  expect(parseCondition({ file: "src\\a\\*.ts" })).toEqual({ file: "src/a/*.ts" });
  expect(parseCondition({ domain: "Database" })).toEqual({ domain: "database" });
  expect(parseCondition({ repo: "remote:github.com/acme/app" })).toEqual({
    repo: "remote:github.com/acme/app",
  });
});

test("AST: invalid leaves/shapes reject", () => {
  expect(() => parseCondition({ language: "cobol" })).toThrow();
  expect(() => parseCondition({ domain: "frontend" })).toThrow(); // not a known domain
  expect(() => parseCondition({ file: "" })).toThrow();
  expect(() => parseCondition({ all: [] })).toThrow(); // empty all invalid
  expect(() => parseCondition({ any: [] })).toThrow(); // empty any invalid
  expect(() => parseCondition({ language: "ts", file: "x" })).toThrow(); // two keys
  expect(() => parseCondition({ nope: "x" })).toThrow();
});

// ---- canonicalization -------------------------------------------------------

test("canonicalization: member order does not change identity", () => {
  const a: Condition = { all: [{ language: "typescript" }, { file: "src/**/*.ts" }] };
  const b: Condition = { all: [{ file: "src/**/*.ts" }, { language: "typescript" }] };
  expect(conditionToCanonicalJson(a)).toBe(conditionToCanonicalJson(b));
});

test("canonical equality via parse: aliases collapse once normalized", () => {
  // Leaf normalization (ts → typescript) happens at parse; combined with canonical
  // ordering, two differently-written conditions become byte-identical.
  const a = parseCondition({ all: [{ language: "ts" }, { file: "src/**/*.ts" }] });
  const b = parseCondition({ all: [{ file: "src/**/*.ts" }, { language: "typescript" }] });
  expect(conditionToCanonicalJson(a)).toBe(conditionToCanonicalJson(b));
});

test("canonicalization: round-trips through JSON", () => {
  const c: Condition = { any: [{ language: "python" }, { not: { domain: "database" } }] };
  const json = conditionToCanonicalJson(c);
  expect(conditionToCanonicalJson(conditionFromJson(json)!)).toBe(json);
  expect(conditionFromJson(null)).toBeNull();
});

// ---- --when parsing ---------------------------------------------------------

test("--when: single leaf, repeated → ALL, alias normalization", () => {
  expect(buildWhenCondition(["language=ts"], identityResolver)).toEqual({ language: "typescript" });
  expect(
    buildWhenCondition(["language=typescript", "file=src/**/*.ts"], identityResolver),
  ).toEqual(canonicalizeCondition({ all: [{ language: "typescript" }, { file: "src/**/*.ts" }] }));
});

test("--when: rejects unknown key, empty value, and does NOT parse expressions", () => {
  expect(() => parseWhenFlag("branch=main")).toThrow(); // unknown key
  expect(() => parseWhenFlag("language=")).toThrow(); // empty value
  expect(() => parseWhenFlag("language")).toThrow(); // no '='
  // `&&` is NOT an expression operator — it becomes part of the value, which then
  // fails language validation rather than being parsed as a compound condition.
  expect(() => buildWhenCondition(["language=typescript && domain=frontend"], identityResolver)).toThrow();
});

// ---- evaluator: language ----------------------------------------------------

test("evaluator language: ts alias matches typescript", () => {
  const r = evaluateCondition({ language: "ts" }, rc({ languages: new Set(["typescript"]) }));
  expect(r.matched).toBe(true);
  expect(r.reason).toContain("typescript");
});

test("evaluator language: python does not match typescript", () => {
  const r = evaluateCondition({ language: "typescript" }, rc({ languages: new Set(["python"]) }));
  expect(r.matched).toBe(false);
});

test("evaluator language: unavailable context → no match (never guess)", () => {
  const r = evaluateCondition({ language: "typescript" }, rc({ languages: new Set() }));
  expect(r.matched).toBe(false);
  expect(r.reason).toContain("no language");
});

// ---- evaluator: file --------------------------------------------------------

test("evaluator file: nested tsx matches, unrelated does not, missing → no match", () => {
  expect(
    evaluateCondition({ file: "**/*.tsx" }, rc({ files: ["src/a/App.tsx"] })).matched,
  ).toBe(true);
  expect(
    evaluateCondition({ file: "src/**/*.ts" }, rc({ files: ["src/a/b.ts"] })).matched,
  ).toBe(true);
  expect(evaluateCondition({ file: "**/*.tsx" }, rc({ files: ["README.md"] })).matched).toBe(false);
  const missing = evaluateCondition({ file: "**/*.tsx" }, rc({ files: [] }));
  expect(missing.matched).toBe(false);
  expect(missing.reason).toContain("unavailable");
});

// ---- evaluator: domain ------------------------------------------------------

test("evaluator domain: matches equal domain, fails mismatch and unavailable", () => {
  expect(evaluateCondition({ domain: "database" }, rc({ domain: "database" })).matched).toBe(true);
  const mismatch = evaluateCondition({ domain: "database" }, rc({ domain: "ui-framework" }));
  expect(mismatch.matched).toBe(false);
  expect(mismatch.reason).toContain("did not match");
  expect(evaluateCondition({ domain: "database" }, rc({ domain: null })).matched).toBe(false);
});

// ---- evaluator: repo --------------------------------------------------------

test("evaluator repo: matches by identity, not by another repo or missing", () => {
  const repo = { id: "r1", name: "app", identity: "remote:github.com/acme/app" };
  expect(
    evaluateCondition({ repo: "remote:github.com/acme/app" }, rc({ repo })).matched,
  ).toBe(true);
  expect(
    evaluateCondition({ repo: "remote:github.com/acme/other" }, rc({ repo })).matched,
  ).toBe(false);
  expect(
    evaluateCondition({ repo: "remote:github.com/acme/app" }, rc({ repo: null })).matched,
  ).toBe(false);
});

// ---- evaluator: logic -------------------------------------------------------

test("evaluator logic: all/any/not and nesting", () => {
  const ctx = rc({ languages: new Set(["typescript"]), domain: "database" });

  expect(evaluateCondition({ all: [{ language: "typescript" }, { domain: "database" }] }, ctx).matched).toBe(true);
  expect(evaluateCondition({ all: [{ language: "typescript" }, { domain: "testing" }] }, ctx).matched).toBe(false);
  expect(evaluateCondition({ any: [{ language: "python" }, { domain: "database" }] }, ctx).matched).toBe(true);
  expect(evaluateCondition({ any: [{ language: "python" }, { domain: "testing" }] }, ctx).matched).toBe(false);
  expect(evaluateCondition({ not: { domain: "testing" } }, ctx).matched).toBe(true);
  expect(evaluateCondition({ not: { domain: "database" } }, ctx).matched).toBe(false);

  // Nested all/any/not.
  const nested: Condition = {
    all: [{ language: "typescript" }, { any: [{ domain: "testing" }, { not: { domain: "ui-framework" } }] }],
  };
  expect(evaluateCondition(nested, ctx).matched).toBe(true);
});

test("evaluator logic: defensive empty all/any do not match", () => {
  expect(evaluateCondition({ all: [] } as unknown as Condition, rc({})).matched).toBe(false);
  expect(evaluateCondition({ any: [] } as unknown as Condition, rc({})).matched).toBe(false);
});

// ---- rendering --------------------------------------------------------------

test("rendering: compact and multi-line forms", () => {
  const c: Condition = canonicalizeCondition({
    all: [{ language: "typescript" }, { file: "src/**/*.ts" }],
  });
  expect(compactCondition(c)).toContain("language=typescript");
  expect(compactCondition(c)).toContain("all(");
  const lines = renderConditionLines(c);
  expect(lines[0]).toBe("ALL");
  expect(lines.some((l) => l.includes("language = typescript"))).toBe(true);
});
