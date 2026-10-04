import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsStore } from "../src/core/stats/stats.ts";

function home(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ctx-stats-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("per-agent counters accumulate and preserve aggregate totals", () => {
  const h = home();
  try {
    const s = new StatsStore(h.dir);
    s.recordHookInjection(2, "claude");
    s.recordHookInjection(1, "codex");
    s.recordHookNoMatch("codex");
    const r = s.read();
    expect(r.hookRuns).toBe(3); // aggregate preserved
    expect(r.contextInjections).toBe(2);
    expect(r.hookRunsByAgent).toEqual({ claude: 1, codex: 2 });
    expect(r.contextInjectionsByAgent).toEqual({ claude: 1, codex: 1 });
  } finally {
    h.cleanup();
  }
});

test("OLD stats files (no per-agent maps) still read, defaulting to empty maps", () => {
  const h = home();
  try {
    // A pre-0.2.9 stats.json without the new fields.
    writeFileSync(
      join(h.dir, "stats.json"),
      JSON.stringify({ version: 1, hook_runs: 5, context_injections: 4, no_match: 1, preferences_injected: 9, proposals_created: 0, last_injection_at: null }),
    );
    const s = new StatsStore(h.dir);
    const r = s.read();
    expect(r.hookRuns).toBe(5);
    expect(r.contextInjections).toBe(4);
    expect(r.hookRunsByAgent).toEqual({});
    expect(r.contextInjectionsByAgent).toEqual({});

    // A subsequent per-agent record writes the maps without losing the old totals.
    s.recordHookInjection(1, "codex");
    const r2 = s.read();
    expect(r2.hookRuns).toBe(6);
    expect(r2.contextInjectionsByAgent).toEqual({ codex: 1 });
    // The serialized file now carries the new keys.
    const onDisk = JSON.parse(readFileSync(join(h.dir, "stats.json"), "utf8"));
    expect(onDisk).toHaveProperty("context_injections_by_agent");
  } finally {
    h.cleanup();
  }
});

test("corrupt per-agent map values are dropped (privacy/robustness gate)", () => {
  const h = home();
  try {
    writeFileSync(
      join(h.dir, "stats.json"),
      JSON.stringify({ version: 1, hook_runs_by_agent: { codex: 3, bad: "x", neg: -5 }, context_injections_by_agent: "nope" }),
    );
    const s = new StatsStore(h.dir);
    const r = s.read();
    expect(r.hookRunsByAgent).toEqual({ codex: 3 }); // bad/neg dropped
    expect(r.contextInjectionsByAgent).toEqual({}); // non-object dropped
  } finally {
    h.cleanup();
  }
});
