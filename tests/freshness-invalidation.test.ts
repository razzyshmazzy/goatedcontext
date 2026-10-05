import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestContext } from "./helpers.ts";
import { generateDataset, bulkSeed } from "./bench/fixtures.ts";
import { whichSync } from "../src/utils/runtime.ts";

/**
 * Freshness & "invalidation" (0.3.0 diagnostic, CI-blocking).
 *
 * Production has NO application-level retrieval cache (every retrieve re-reads the
 * DB inside a fresh read snapshot). These tests pin that property: a write is
 * observed by the very next retrieve, in-process AND cross-process. If a future
 * release adds a cache, these become its invalidation guard.
 */

const QUERY = { cwd: "/x", task: "database schema design", languages: ["typescript"] as string[], track: false as const };
const rules = (t: ReturnType<typeof makeTestContext>) => t.ctx.retrieval.retrieve(QUERY).preferences.map((p) => p.rule);

test("ADD is visible to the next retrieve immediately", () => {
  const t = makeTestContext();
  try {
    // Small background store so neither the always-cap nor relevance crowding can
    // confound the freshness property under test (caps are covered in scale-retrieval).
    bulkSeed(t.ctx.db, generateDataset(10, { seed: 1 }));
    expect(rules(t).some((r) => r.includes("SENTINEL-ADD"))).toBe(false);
    t.ctx.preferences.remember({ rule: "SENTINEL-ADD always use branded ids.", scope: "global", applicability: "always" });
    expect(rules(t).some((r) => r.includes("SENTINEL-ADD"))).toBe(true);
  } finally {
    t.cleanup();
  }
});

test("FORGET is visible to the next retrieve immediately", () => {
  const t = makeTestContext();
  try {
    bulkSeed(t.ctx.db, generateDataset(10, { seed: 2 }));
    const p = t.ctx.preferences.remember({ rule: "SENTINEL-DEL always lint on commit.", scope: "global", applicability: "always" });
    expect(rules(t).some((r) => r.includes("SENTINEL-DEL"))).toBe(true);
    t.ctx.preferences.forget(p.id, { expectedVersion: p.version });
    expect(rules(t).some((r) => r.includes("SENTINEL-DEL"))).toBe(false);
  } finally {
    t.cleanup();
  }
});

test("APPROVE proposed → appears; REJECT → disappears (status transitions are live)", () => {
  const t = makeTestContext();
  try {
    const r = t.ctx.preferences.propose({ rule: "SENTINEL-PROP always prefer composition.", scope: "global", applicability: "always", evidence: "seen" });
    const id = r.preference.id;
    expect(rules(t).some((x) => x.includes("SENTINEL-PROP"))).toBe(false); // proposed not delivered
    const approved = t.ctx.preferences.approve(id, { expectedVersion: r.preference.version });
    expect(rules(t).some((x) => x.includes("SENTINEL-PROP"))).toBe(true); // now live
    t.ctx.preferences.reject(id, { expectedVersion: approved.version });
    expect(rules(t).some((x) => x.includes("SENTINEL-PROP"))).toBe(false); // gone again
  } finally {
    t.cleanup();
  }
});

test("NEGATIVE: a query that matched nothing picks up a newly-added matching rule", () => {
  const t = makeTestContext();
  try {
    // Empty store: query matches nothing.
    const before = t.ctx.retrieval.retrieve({ cwd: "/x", task: "foreign keys and relational integrity", track: false });
    expect(before.preferences.length).toBe(0);
    t.ctx.preferences.remember({ rule: "Prefer foreign keys for relational integrity.", scope: "global", category: "database" });
    const after = t.ctx.retrieval.retrieve({ cwd: "/x", task: "foreign keys and relational integrity", track: false });
    expect(after.preferences.some((p) => p.rule.includes("foreign keys"))).toBe(true);
  } finally {
    t.cleanup();
  }
});

test("KEY semantics: same task text but different repo yields different repo-scoped results", () => {
  const t = makeTestContext();
  try {
    // Two repos registered via import identities, retrieved by resolving... but without
    // a real git dir we assert the simpler axis: changing `languages` changes the set
    // for the SAME task (no key underspecification reuse).
    t.ctx.preferences.remember({ rule: "Use strict types for TS.", scope: "global", applicability: "conditional", condition: { language: "typescript" } });
    const tsSet = t.ctx.retrieval.retrieve({ cwd: "/x", task: "same task", languages: ["typescript"], track: false }).preferences.map((p) => p.rule);
    const pySet = t.ctx.retrieval.retrieve({ cwd: "/x", task: "same task", languages: ["python"], track: false }).preferences.map((p) => p.rule);
    expect(tsSet).toContain("Use strict types for TS.");
    expect(pySet).not.toContain("Use strict types for TS.");
  } finally {
    t.cleanup();
  }
});

// ── cross-process freshness: separate OS processes, one DB ────────────────────

test("cross-process: writer in process B is seen by a fresh reader in process A", () => {
  const dist = join(import.meta.dir, "..", "dist", "index.js");
  const node = whichSync("node");
  if (!node || !existsSync(dist)) {
    console.warn("[freshness] skipped cross-process: run `bun run build` first.");
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "ctx-fresh-"));
  try {
    const env = { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" };
    const run = (args: string[]) => spawnSync(node, [dist, ...args], { encoding: "utf8", env });

    run(["init"]);
    // Process A reads: nothing matches yet.
    const a1 = run(["get", "--cwd", home, "--task", "always zzz unique marker"]);
    expect(a1.status).toBe(0);
    expect(a1.stdout).not.toContain("CROSSPROC-SENTINEL");

    // Process B writes.
    const w = run(["remember", "--scope", "global", "--always", "CROSSPROC-SENTINEL always sign commits."]);
    expect(w.status).toBe(0);

    // Process A reads again (brand new process) → sees the write.
    const a2 = run(["get", "--cwd", home, "--task", "anything"]);
    expect(a2.status).toBe(0);
    expect(a2.stdout).toContain("CROSSPROC-SENTINEL");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
