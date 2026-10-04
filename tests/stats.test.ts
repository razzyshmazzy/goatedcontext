import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsStore, zeroStats, toJson } from "../src/core/stats/stats.ts";
import { timeAgo } from "../src/utils/time.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "ctx-stats-"));
}

test("zero state: fresh store reports all zeros and no last injection", () => {
  const dir = home();
  const store = new StatsStore(dir);
  expect(store.read()).toEqual(zeroStats());
  // No file is created just by reading.
  expect(existsSync(join(dir, "stats.json"))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("hook_runs / context_injections / preferences_injected / last_injection_at on injection", () => {
  const dir = home();
  const store = new StatsStore(dir);
  expect(store.recordHookInjection(3)).toBe(true);
  expect(store.recordHookInjection(2)).toBe(true);
  const s = store.read();
  expect(s.hookRuns).toBe(2);
  expect(s.contextInjections).toBe(2);
  expect(s.noMatch).toBe(0);
  expect(s.preferencesInjected).toBe(5);
  expect(s.lastInjectionAt).not.toBeNull();
  // last_injection_at is a real ISO timestamp.
  expect(Number.isNaN(Date.parse(s.lastInjectionAt!))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("no_match increments hook_runs but not injections", () => {
  const dir = home();
  const store = new StatsStore(dir);
  store.recordHookNoMatch();
  store.recordHookNoMatch();
  store.recordHookInjection(1);
  const s = store.read();
  expect(s.hookRuns).toBe(3);
  expect(s.noMatch).toBe(2);
  expect(s.contextInjections).toBe(1);
  expect(s.preferencesInjected).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("proposals_created increments independently", () => {
  const dir = home();
  const store = new StatsStore(dir);
  store.recordProposalCreated();
  store.recordProposalCreated();
  const s = store.read();
  expect(s.proposalsCreated).toBe(2);
  expect(s.hookRuns).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

test("JSON shape is stable snake_case with a raw ISO timestamp", () => {
  const dir = home();
  const store = new StatsStore(dir);
  store.recordHookInjection(4);
  const j = toJson(store.read());
  expect(Object.keys(j).sort()).toEqual(
    [
      "context_injections",
      "context_injections_by_agent",
      "hook_runs",
      "hook_runs_by_agent",
      "last_injection_at",
      "no_match",
      "preferences_injected",
      "proposals_created",
    ].sort(),
  );
  expect(j.preferences_injected).toBe(4);
  expect(typeof j.last_injection_at).toBe("string");
  rmSync(dir, { recursive: true, force: true });
});

test("reset clears counters only", () => {
  const dir = home();
  const store = new StatsStore(dir);
  store.recordHookInjection(3);
  store.recordProposalCreated();
  expect(store.reset()).toBe(true);
  expect(store.read()).toEqual(zeroStats());
  rmSync(dir, { recursive: true, force: true });
});

test("missing store reads as zero-state without throwing", () => {
  const dir = home();
  const store = new StatsStore(dir);
  // Never wrote anything.
  expect(() => store.read()).not.toThrow();
  expect(store.read()).toEqual(zeroStats());
  rmSync(dir, { recursive: true, force: true });
});

test("corrupt store recovers to zero-state on read and self-heals on next write", () => {
  const dir = home();
  const store = new StatsStore(dir);
  writeFileSync(join(dir, "stats.json"), "not json {{{ definitely broken", "utf8");
  // Read must not throw and must report zero.
  expect(store.read()).toEqual(zeroStats());
  // A subsequent write overwrites the garbage with a valid store.
  expect(store.recordHookNoMatch()).toBe(true);
  const s = store.read();
  expect(s.hookRuns).toBe(1);
  expect(s.noMatch).toBe(1);
  // File is valid JSON again.
  expect(() => JSON.parse(readFileSync(join(dir, "stats.json"), "utf8"))).not.toThrow();
  rmSync(dir, { recursive: true, force: true });
});

test("privacy: only aggregate counters and one timestamp are ever persisted", () => {
  const dir = home();
  const store = new StatsStore(dir);
  store.recordHookInjection(2);
  store.recordProposalCreated();
  const raw = JSON.parse(readFileSync(join(dir, "stats.json"), "utf8"));
  const allowed = new Set([
    "version",
    "hook_runs",
    "context_injections",
    "no_match",
    "preferences_injected",
    "proposals_created",
    "last_injection_at",
    "hook_runs_by_agent",
    "context_injections_by_agent",
  ]);
  const agentMaps = new Set(["hook_runs_by_agent", "context_injections_by_agent"]);
  for (const key of Object.keys(raw)) expect(allowed.has(key)).toBe(true);
  // Every value is a number, the single ISO timestamp (or null), or — for the
  // per-agent maps — an object whose keys are agent names and values are numbers.
  for (const [key, val] of Object.entries(raw)) {
    if (key === "last_injection_at") {
      expect(val === null || typeof val === "string").toBe(true);
    } else if (agentMaps.has(key)) {
      expect(typeof val).toBe("object");
      for (const v of Object.values(val as Record<string, unknown>)) expect(typeof v).toBe("number");
    } else {
      expect(typeof val).toBe("number");
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

test("privacy: extraneous fields injected into the store are discarded, not propagated", () => {
  const dir = home();
  const store = new StatsStore(dir);
  // Simulate a tampered/legacy file carrying content that must never survive.
  writeFileSync(
    join(dir, "stats.json"),
    JSON.stringify({
      hook_runs: 5,
      prompt: "secret user prompt text",
      repo_path: "/home/alice/private-repo",
      session_id: "sess-123",
      OPENAI_API_KEY: "sk-abc",
    }),
    "utf8",
  );
  // Read keeps only the known counter.
  const s = store.read();
  expect(s.hookRuns).toBe(5);
  // A write re-serializes WITHOUT the smuggled fields.
  store.recordHookNoMatch();
  const raw = readFileSync(join(dir, "stats.json"), "utf8");
  expect(raw).not.toContain("secret user prompt text");
  expect(raw).not.toContain("private-repo");
  expect(raw).not.toContain("sess-123");
  expect(raw).not.toContain("OPENAI_API_KEY");
  expect(raw).not.toContain("sk-abc");
  rmSync(dir, { recursive: true, force: true });
});

test("negative / non-integer / NaN counters are coerced to safe integers", () => {
  const dir = home();
  const store = new StatsStore(dir);
  writeFileSync(
    join(dir, "stats.json"),
    JSON.stringify({ hook_runs: -3, context_injections: 2.9, no_match: "x", preferences_injected: null }),
    "utf8",
  );
  const s = store.read();
  expect(s.hookRuns).toBe(0); // negative -> 0
  expect(s.contextInjections).toBe(2); // floored
  expect(s.noMatch).toBe(0); // non-number -> 0
  expect(s.preferencesInjected).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

test("recording is fail-open when the store path is unwritable", () => {
  const dir = home();
  // Make stats.json a directory so a file write can never succeed.
  const bogus = join(dir, "stats.json");
  require("node:fs").mkdirSync(bogus, { recursive: true });
  const store = new StatsStore(dir);
  // Must not throw; returns false to signal it could not persist.
  let result: boolean | undefined;
  expect(() => {
    result = store.recordHookInjection(1);
  }).not.toThrow();
  expect(result).toBe(false);
  // Reading also never throws.
  expect(() => store.read()).not.toThrow();
  rmSync(dir, { recursive: true, force: true });
});

test("timeAgo renders sensible relative phrases", () => {
  const now = new Date("2026-09-28T12:00:00.000Z");
  expect(timeAgo(null, now)).toBe("(never)");
  expect(timeAgo("2026-09-28T11:58:00.000Z", now)).toBe("2 minutes ago");
  expect(timeAgo("2026-09-28T11:00:00.000Z", now)).toBe("1 hour ago");
  expect(timeAgo("2026-09-26T12:00:00.000Z", now)).toBe("2 days ago");
  expect(timeAgo("2026-09-28T11:59:58.000Z", now)).toBe("just now");
  // Clock skew (future timestamp) never reads as "in the future".
  expect(timeAgo("2026-09-28T12:05:00.000Z", now)).toBe("just now");
});
