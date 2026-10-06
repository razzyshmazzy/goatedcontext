import { test, expect } from "bun:test";
import { makeTestContext, makeGitRepo } from "./helpers.ts";
import { simulateAgent } from "../src/adapters/test-hook.ts";
import { buildProjection, renderAgentsBlock } from "../src/core/project/projection.ts";

/**
 * Cross-agent signal evidence (0.3.4, §18/§J/§K). Signals written by one agent are
 * visible to another (provenance never gates visibility), evidence is delivered only
 * through RUNTIME injection (Claude/Codex), and NEVER through static projection
 * (AGENTS.md) or to an agent without runtime injection (Cursor).
 */

test("H+I. a signal written by Claude is visible to Codex, and vice versa (provenance never gates)", () => {
  const t = makeTestContext();
  try {
    // Claude records backend=supabase across two repos.
    t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: "rA", agentId: "claude" });
    t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: "rB", agentId: "claude" });
    // Codex records test-framework=vitest across two repos.
    t.ctx.signals.add({ domain: "testing", choice: "vitest", repoId: "rA", agentId: "codex" });
    t.ctx.signals.add({ domain: "testing", choice: "vitest", repoId: "rC", agentId: "codex" });

    // Codex sees the Claude-written backend evidence.
    const codex = simulateAgent(t.ctx, { agent: "codex", cwd: "/x", task: "set up the backend" });
    expect(codex.observedPatterns!.find((p) => p.domain === "backend")?.choices[0]?.label).toBe("supabase");
    expect(codex.block!.toLowerCase()).toContain("supabase");

    // Claude sees the Codex-written testing evidence.
    const claude = simulateAgent(t.ctx, { agent: "claude", cwd: "/x", task: "add some unit tests with the test runner" });
    expect(claude.observedPatterns!.find((p) => p.domain === "testing")?.choices[0]?.label).toBe("vitest");
    expect(claude.block!.toLowerCase()).toContain("vitest");
  } finally {
    t.cleanup();
  }
});

test("J. signals NEVER appear in the static AGENTS.md projection", () => {
  const t = makeTestContext();
  const repo = makeGitRepo();
  try {
    // A repo always-on preference (which DOES project) + signals (which must not).
    t.ctx.preferences.remember({
      rule: "Always run the formatter before committing.",
      scope: "repo",
      repoId: t.ctx.repos.resolve(repo.root)!.id,
      applicability: "always",
    });
    t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: t.ctx.repos.resolve(repo.root)!.id });
    t.ctx.signals.add({ domain: "package-manager", choice: "bun", repoId: t.ctx.repos.resolve(repo.root)!.id });

    const block = renderAgentsBlock(buildProjection(t.ctx, repo.root));
    expect(block).toContain("Always run the formatter before committing.");
    expect(block.toLowerCase()).not.toContain("supabase");
    expect(block.toLowerCase()).not.toContain("bun");
    expect(block.toLowerCase()).not.toContain("observed developer decisions");
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});

test("K. Cursor (no runtime injection) never receives signal evidence", () => {
  const t = makeTestContext();
  try {
    for (const r of ["rA", "rB", "rC"]) t.ctx.signals.add({ domain: "backend", choice: "supabase", repoId: r });
    const cursor = simulateAgent(t.ctx, { agent: "cursor", cwd: "/x", task: "set up the backend" });
    expect(cursor.runtimeSupported).toBe(false);
    expect(cursor.block).toBeNull();
    expect(cursor.observedPatterns).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});
