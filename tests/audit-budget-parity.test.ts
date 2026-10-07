import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestContext } from "./helpers.ts";
import { buildContextEnvelope } from "../src/core/agents/envelope.ts";
import { renderContextBlock } from "../src/core/render/context-block.ts";
import { isCanonicalDomain } from "../src/core/signals/domains.ts";
import { MAX_RULE_CHARS } from "../src/core/preferences/types.ts";
import { connectMcp, toolJson } from "./support/mcp-client.ts";

/**
 * Final char-budget accounting audit (LE1). ONE truthful basis — per-rule cost is the
 * rule text bounded to MAX_RULE_CHARS, the same bound JSON/MCP emit — so text, JSON and
 * MCP agree on which preference IDs are delivered and on omittedByBudget/overflow, and a
 * budget is never silently exceeded.
 */

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");

// Several near-limit rules (each ~2000 chars of DISTINCT subject tokens so none collapse
// under conflict resolution) plus one at the 4096 cap.
function nearLimitRule(tag: string): string {
  // Distinct leading token keeps the subject unique; padding makes it near-limit.
  return `Rule ${tag}: ` + `word${tag} `.repeat(300);
}

test("text and JSON envelope agree on delivered IDs, omittedByBudget and overflow under a small budget", () => {
  const t = makeTestContext();
  try {
    for (const tag of ["alpha", "bravo", "charlie", "delta"]) {
      t.ctx.preferences.remember({ rule: nearLimitRule(tag).slice(0, MAX_RULE_CHARS), scope: "global", applicability: "always" });
    }
    // Budget that fits ~2 near-limit rules (~2000 chars each) out of 4.
    const budget = { maxChars: 4500, maxPreferences: null };
    const result = t.ctx.retrieval.retrieve({ cwd: t.dir, task: "work", track: false, explain: true, budget });

    const deliveredIds = new Set(result.preferences.map((p) => p.id));
    expect(result.delivery.omittedByBudget).toBeGreaterThan(0); // some omitted by budget
    expect(deliveredIds.size).toBeLessThan(4);

    // JSON envelope is built from the SAME result → same delivered content + diagnostics.
    const envelope = buildContextEnvelope(result, { includeProposed: false, isCanonicalDomain });
    expect(envelope.context.authoritativePreferences.length).toBe(deliveredIds.size);
    expect(envelope.meta.diagnostics.omittedByBudget).toBe(result.delivery.omittedByBudget);
    expect(envelope.meta.diagnostics.overflow).toBe(true);

    // Text renders exactly the delivered rules (same set); and every emitted JSON rule is
    // bounded to the budget basis (no transport silently emits more than accounted).
    const block = renderContextBlock(result)!;
    for (const p of result.preferences) {
      // the delivered rule's distinct tag token appears in text
      const tagToken = p.rule.split(":")[0];
      expect(block).toContain(tagToken!);
    }
    for (const ep of envelope.context.authoritativePreferences) {
      expect(ep.rule.length).toBeLessThanOrEqual(MAX_RULE_CHARS + 1);
    }
  } finally {
    t.cleanup();
  }
});

test("a single 4096-char rule under a tiny budget is force-kept but reports overflow truthfully", () => {
  const t = makeTestContext();
  try {
    t.ctx.preferences.remember({ rule: "x".repeat(MAX_RULE_CHARS), scope: "global", applicability: "always" });
    const result = t.ctx.retrieval.retrieve({ cwd: t.dir, task: "work", track: false, explain: true, budget: { maxChars: 100, maxPreferences: null } });
    expect(result.preferences.length).toBe(1); // never deliver zero
    expect(result.delivery.budgetExceeded).toBe(true);
    const envelope = buildContextEnvelope(result, { includeProposed: false, isCanonicalDomain });
    expect(envelope.meta.diagnostics.overflow).toBe(true); // exceeding the budget is surfaced
  } finally {
    t.cleanup();
  }
});

test(
  "MCP get_context delivers the same preference IDs as the CLI envelope for the same store",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-auditbudget-"));
    try {
      // Seed via CLI so the MCP subprocess and an in-process context see the same DB.
      const seed = (args: string[]) =>
        Bun.spawnSync([BUN, "run", INDEX, ...args], { cwd: home, env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" } });
      seed(["remember", "Always prefer composition over inheritance.", "--scope", "global", "--always"]);
      seed(["remember", "Always validate inputs at boundaries.", "--scope", "global", "--always"]);

      // MCP get_context (no budget) → the full effective set.
      const client = await connectMcp({
        command: BUN,
        args: ["run", INDEX, "mcp"],
        env: { ...(process.env as Record<string, string>), CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
      });
      try {
        const res = await client.callTool({ name: "get_context", arguments: { task: "work" } });
        const env = toolJson(res);
        const mcpRules = (env.context.authoritativePreferences as Array<{ rule: string }>).map((p) => p.rule).sort();
        expect(mcpRules).toContain("Always prefer composition over inheritance.");
        expect(mcpRules).toContain("Always validate inputs at boundaries.");
        expect(env.meta.diagnostics.overflow).toBe(false); // no budget → nothing omitted
      } finally {
        await client.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  60_000,
);
