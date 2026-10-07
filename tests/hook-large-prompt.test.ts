import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";
import { boundQueryText, MAX_QUERY_ANALYSIS_CHARS } from "../src/core/preferences/analysis.ts";

/**
 * Large-prompt hook latency (Wave 2). Retrieval tokenized/stemmed the whole task text
 * several times, so hook overhead scaled with raw prompt size. ctx now analyzes a
 * bounded query representation (head + tail); the agent's prompt is never changed.
 */

test("boundQueryText caps length, keeps short tasks verbatim, is deterministic", () => {
  expect(boundQueryText("short task")).toBe("short task");
  const big = "x".repeat(5_000_000);
  const bounded = boundQueryText(big);
  expect(bounded.length).toBeLessThanOrEqual(MAX_QUERY_ANALYSIS_CHARS + 5); // + ellipsis
  expect(boundQueryText(big)).toBe(bounded); // deterministic
  // Head and tail are both represented.
  const b2 = boundQueryText("HEAD" + "y".repeat(5_000_000) + "TAIL");
  expect(b2.startsWith("HEAD")).toBe(true);
  expect(b2.endsWith("TAIL")).toBe(true);
});

test("retrieval latency stays flat as prompt size grows from 1KB to 2MB", () => {
  const t = makeTestContext();
  try {
    for (let i = 0; i < 40; i++) {
      t.ctx.preferences.remember({ rule: `Prefer approach ${i} for database and testing.`, scope: "global" });
    }
    const unit = "Refactor the database layer and add tests for the React component with error handling. ";
    const make = (kb: number) => unit.repeat(Math.ceil((kb * 1024) / unit.length)).slice(0, kb * 1024);
    const cwd = process.cwd();

    const timeFor = (kb: number): number => {
      const p = make(kb);
      t.ctx.retrieval.retrieve({ cwd, task: p, track: false }); // warm
      const N = 10;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) t.ctx.retrieval.retrieve({ cwd, task: p, track: false });
      return (performance.now() - t0) / N;
    };

    const small = timeFor(1);
    const huge = timeFor(2048);
    // With input-size work bounded, 2MB must not cost materially more than 1KB. Allow a
    // generous absolute slack for machine noise and the fixed per-call overhead.
    expect(huge).toBeLessThan(small + 60);
  } finally {
    t.cleanup();
  }
}, 60_000);

test("domain + relevance detection is unchanged for an ordinary small prompt", () => {
  const t = makeTestContext();
  try {
    t.ctx.preferences.remember({ rule: "Use Postgres for the database.", scope: "global" });
    t.ctx.preferences.remember({ rule: "Write tests with the built-in runner.", scope: "global" });
    const res = t.ctx.retrieval.retrieve({
      cwd: process.cwd(),
      task: "help me design the database schema and migrations",
      track: false,
      explain: true,
    });
    // The database rule should surface for a database task.
    expect(res.preferences.some((p) => /postgres/i.test(p.rule))).toBe(true);
    expect(res.runtimeContext?.domain).toBe("database"); // domain inference intact
  } finally {
    t.cleanup();
  }
});
