import { test, expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whichSync } from "../src/utils/runtime.ts";
import { StatsStore } from "../src/core/stats/stats.ts";
import { makeTestContext } from "./helpers.ts";

/**
 * Stats accuracy under concurrency (§32) and history accuracy (§33).
 */

const dist = join(import.meta.dir, "..", "dist", "index.js");
const node = whichSync("node");
const canRun = Boolean(node && existsSync(dist));

function spawnHook(env: NodeJS.ProcessEnv, payload: string): Promise<number | null> {
  return new Promise((resolve) => {
    const c = spawn(node!, [dist, "hook", "codex-prompt"], { env });
    c.on("close", (code) => resolve(code));
    c.stdin.end(payload);
  });
}

test(
  "stats: 20 concurrent hook processes record every run (no lost increments via the file lock)",
  async () => {
    if (!canRun) { console.warn("[stats] skipped: build first."); return; }
    const home = mkdtempSync(join(tmpdir(), "ctx-stats-"));
    const env = { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" };
    try {
      spawnSync(node!, [dist, "init"], { env });
      // An always-rule so every hook injects (context_injections == hook_runs).
      spawnSync(node!, [dist, "remember", "--scope", "global", "--always", "Always be consistent."], { env });

      const N = 20;
      const payload = JSON.stringify({ cwd: home, prompt: "do work" });
      const codes = await Promise.all(Array.from({ length: N }, () => spawnHook(env, payload)));
      expect(codes.every((c) => c === 0)).toBe(true);

      const stats = JSON.parse(spawnSync(node!, [dist, "stats", "--json"], { env, encoding: "utf8" }).stdout) as { hook_runs: number; context_injections: number };
      expect(stats.hook_runs).toBe(N); // exact — the cross-process lock loses nothing
      expect(stats.context_injections).toBe(N);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  90_000,
);

test("stats: a corrupt stats.json self-heals to a clean zero-state on read (no crash)", () => {
  const home = mkdtempSync(join(tmpdir(), "ctx-stats-corrupt-"));
  try {
    writeFileSync(join(home, "stats.json"), "{ not valid json at all");
    const store = new StatsStore(home);
    const read = store.read();
    expect(read.hookRuns).toBe(0); // corrupt → zero, not a throw
    // A subsequent write overwrites the corruption with a valid file.
    expect(store.recordHookNoMatch("codex")).toBe(true);
    expect(store.read().hookRuns).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("stats: a hand-edited file cannot smuggle non-counter data (privacy gate)", () => {
  const home = mkdtempSync(join(tmpdir(), "ctx-stats-priv-"));
  try {
    writeFileSync(join(home, "stats.json"), JSON.stringify({ hook_runs: 3, secret: "LEAK", last_injection_at: "2026-01-01T00:00:00.000Z", hook_runs_by_agent: { claude: 2, evil: -9 } }));
    const store = new StatsStore(home);
    const s = store.read();
    const json = JSON.stringify(s);
    expect(json).not.toContain("LEAK"); // unknown fields dropped
    expect(s.hookRuns).toBe(3);
    expect(s.hookRunsByAgent).toEqual({ claude: 2 }); // negative/invalid dropped
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── history accuracy (in-process, deterministic) ─────────────────────────────

test("history: a full lifecycle emits exactly one event per transition, in causal order", () => {
  const t = makeTestContext();
  try {
    const p = t.ctx.preferences.remember({ rule: "Prefer explicit return types.", scope: "global" });
    const approved = t.ctx.preferences.lock(p.id, { expectedVersion: p.version });
    t.ctx.preferences.forget(approved.id, { expectedVersion: approved.version });

    const events = t.ctx.events.list({ limit: 100 }).filter((e) => e.preferenceId === p.id);
    const types = events.map((e) => e.type).reverse(); // list() is newest-first
    expect(types).toEqual(["preference.remembered", "preference.locked", "preference.forgotten"]);
    // No duplicate events.
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  } finally {
    t.cleanup();
  }
});

test("history: a proposal dedup merge records evidence_added, not a second 'proposed'", () => {
  const t = makeTestContext();
  try {
    const r1 = t.ctx.preferences.propose({ rule: "Use Redis for caching.", scope: "global", evidence: "seen once" });
    const r2 = t.ctx.preferences.propose({ rule: "Use Redis for caching.", scope: "global", evidence: "seen twice" });
    expect(r2.merged).toBe(true);
    const events = t.ctx.events.list({ limit: 100 }).filter((e) => e.preferenceId === r1.preference.id);
    const proposed = events.filter((e) => e.type === "preference.proposed");
    const merged = events.filter((e) => e.type === "preference.evidence_added");
    expect(proposed.length).toBe(1); // exactly one creation
    expect(merged.length).toBe(1); // the second became an evidence merge
  } finally {
    t.cleanup();
  }
});
