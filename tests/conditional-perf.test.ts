import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";

// A realistic sanity benchmark for the conditional evaluator at scale, per the
// 0.2.8 spec: 10,000 relevant + 100 always + 1,000 conditional preferences.
// Thresholds are deliberately generous (this guards against pathological blow-ups,
// not tight perf targets); actual timings are logged for visibility.

const TIMEOUT = 120_000;
const CWD = process.cwd();
const TOPICS = ["database", "testing", "architecture", "dependencies", "formatting", "infrastructure"];

function ms(n: number): string {
  return `${Math.round(n)}ms`;
}

test(
  "10k relevant + 100 always + 1k conditional: no / few / many matches",
  () => {
    const t = makeTestContext();
    try {
      const seedStart = performance.now();
      for (let i = 0; i < 10_000; i++) {
        t.ctx.preferences.remember({
          rule: `Rule ${i}: prefer approach ${i % 97} for ${TOPICS[i % TOPICS.length]} in module ${i % 250}.`,
          category: TOPICS[i % TOPICS.length]!,
          scope: "global",
          applicability: "relevant",
        });
      }
      for (let i = 0; i < 100; i++) {
        t.ctx.preferences.remember({ rule: `Always apply universal directive ${i}.`, scope: "global", applicability: "always" });
      }
      // 900 language=typescript + 100 domain=database conditionals.
      for (let i = 0; i < 900; i++) {
        t.ctx.preferences.remember({
          rule: `TypeScript conditional ${i}: prefer explicit types.`,
          scope: "global",
          condition: { language: "typescript" },
        });
      }
      for (let i = 0; i < 100; i++) {
        t.ctx.preferences.remember({
          rule: `Database conditional ${i}: prefer foreign keys.`,
          scope: "global",
          condition: { domain: "database" },
        });
      }
      const seedMs = performance.now() - seedStart;

      // No matches: unrelated task, no file context.
      let start = performance.now();
      const none = t.ctx.retrieval.retrieve({ cwd: CWD, task: "say hello", explain: true, track: false });
      const noneMs = performance.now() - start;
      const noneMatched = none.conditionalEvaluations!.filter((e) => e.matched).length;

      // Few matches: a database task (domain conditionals match), still no file.
      start = performance.now();
      const few = t.ctx.retrieval.retrieve({
        cwd: CWD,
        task: "design a database schema with migrations",
        explain: true,
        track: false,
      });
      const fewMs = performance.now() - start;
      const fewMatched = few.conditionalEvaluations!.filter((e) => e.matched).length;

      // Many matches: a TS file is present AND a database task → all 1000 match.
      start = performance.now();
      const many = t.ctx.retrieval.retrieve({
        cwd: CWD,
        task: "design a database schema with migrations",
        files: ["src/app.ts"],
        explain: true,
        track: false,
      });
      const manyMs = performance.now() - start;
      const manyMatched = many.conditionalEvaluations!.filter((e) => e.matched).length;

      console.log(
        `[cond-perf] seed(11.1k)=${ms(seedMs)} | none: ${noneMatched} match ${ms(noneMs)} | ` +
          `few: ${fewMatched} match ${ms(fewMs)} | many: ${manyMatched} match ${ms(manyMs)}`,
      );

      expect(noneMatched).toBe(0);
      expect(fewMatched).toBe(100);
      expect(manyMatched).toBe(1000);
      // Each retrieval evaluates all 1,000 conditions and scores 10,000 relevant
      // rules; a single pass should be well under this on any machine.
      expect(noneMs).toBeLessThan(15_000);
      expect(fewMs).toBeLessThan(15_000);
      expect(manyMs).toBeLessThan(15_000);
    } finally {
      t.cleanup();
    }
  },
  TIMEOUT,
);
