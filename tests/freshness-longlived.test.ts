import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CtxContext } from "../src/core/context.ts";
import { whichSync } from "../src/utils/runtime.ts";

/**
 * Long-lived-process freshness (0.3.0, PERMANENT anti-stale-cache regression).
 *
 * The existing `freshness-invalidation` test proves a FRESH process sees a prior
 * write. This proves the STRONGER property the 0.3.0 SQL-reduction work must never
 * weaken: a process that opens a connection, retrieves, and then retrieves AGAIN on
 * that SAME long-lived connection immediately observes a write committed by another
 * connection in between — add AND delete. Every `retrieve()` opens its own read
 * snapshot (`withReadTx`), so there is no connection-lifetime cache to go stale.
 *
 * If a future release ever adds a retrieval/candidate/connection cache, this test
 * (and `freshness-invalidation`) is its mandatory invalidation guard and must stay
 * green.
 */

const QUERY = { cwd: "/not-a-repo", task: "anything at all", track: false as const };
const delivered = (ctx: CtxContext) => ctx.retrieval.retrieve(QUERY).preferences.map((p) => p.rule);

test("long-lived connection sees an ADD committed by another connection on the next retrieve", () => {
  const home = mkdtempSync(join(tmpdir(), "ctx-ll-add-"));
  const env = { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" } as NodeJS.ProcessEnv;
  // Reader A: opened ONCE and reused for every retrieve below.
  const A = CtxContext.open(env);
  // Writer B: a second, independent connection to the same on-disk WAL database.
  const B = CtxContext.open(env);
  try {
    expect(delivered(A).some((r) => r.includes("LL-ADD"))).toBe(false);

    // B writes; A has NOT been reopened.
    B.preferences.remember({ rule: "LL-ADD always sign every commit.", scope: "global", applicability: "always" });

    // Same long-lived A connection, retrieved again → sees the new rule immediately.
    expect(delivered(A).some((r) => r.includes("LL-ADD"))).toBe(true);
  } finally {
    A.close();
    B.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("long-lived connection sees a DELETE committed by another connection on the next retrieve", () => {
  const home = mkdtempSync(join(tmpdir(), "ctx-ll-del-"));
  const env = { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" } as NodeJS.ProcessEnv;
  const A = CtxContext.open(env);
  const B = CtxContext.open(env);
  try {
    const p = B.preferences.remember({ rule: "LL-DEL always rebase before merge.", scope: "global", applicability: "always" });
    // A (long-lived) sees it first.
    expect(delivered(A).some((r) => r.includes("LL-DEL"))).toBe(true);

    // B forgets it; A is NOT reopened.
    B.preferences.forget(p.id, { expectedVersion: p.version });

    // Same long-lived A connection → the rule is gone immediately, not cached.
    expect(delivered(A).some((r) => r.includes("LL-DEL"))).toBe(false);
  } finally {
    A.close();
    B.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("long-lived in-process reader sees a write from a separate OS process immediately", () => {
  const dist = join(import.meta.dir, "..", "dist", "index.js");
  const node = whichSync("node");
  if (!node || !existsSync(dist)) {
    console.warn("[freshness-longlived] skipped cross-process: run `bun run build` first.");
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "ctx-ll-proc-"));
  const env = { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" } as NodeJS.ProcessEnv;
  // A real separate process initializes + a long-lived in-process reader opens AFTER.
  spawnSync(node, [dist, "init"], { env });
  const A = CtxContext.open(env);
  try {
    expect(delivered(A).some((r) => r.includes("LL-PROC"))).toBe(false);

    // A genuinely separate OS process commits a matching rule.
    const w = spawnSync(node, [dist, "remember", "--scope", "global", "--always", "LL-PROC always run CI before push."], { env, encoding: "utf8" });
    expect(w.status).toBe(0);

    // The SAME long-lived in-process connection A sees it on the next retrieve.
    expect(delivered(A).some((r) => r.includes("LL-PROC"))).toBe(true);
  } finally {
    A.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
