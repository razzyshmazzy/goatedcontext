import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";
import { buildContextEnvelope } from "../src/core/agents/envelope.ts";
import { renderContextBlock } from "../src/core/render/context-block.ts";
import { isCanonicalDomain } from "../src/core/signals/domains.ts";
import { MAX_RULE_CHARS } from "../src/core/preferences/types.ts";
import { nowIso } from "../src/utils/time.ts";

/**
 * Budget parity + legacy oversized-rule handling (Wave 3 §13-17). One budget decision
 * source (the RetrievalResult/delivery plan) drives text AND the JSON/MCP envelope, and
 * a legacy multi-megabyte rule can never flood the structured transport.
 */

test("an explicit budget yields the SAME delivered set + overflow in text and JSON envelope", () => {
  const t = makeTestContext();
  try {
    for (const r of [
      "Always prefer composition over inheritance.",
      "Always validate inputs at boundaries.",
      "Always log errors with structured context.",
    ]) {
      t.ctx.preferences.remember({ rule: r, scope: "global", applicability: "always" });
    }
    const budget = { maxChars: null, maxPreferences: 1 };
    const result = t.ctx.retrieval.retrieve({ cwd: t.dir, task: "work", track: false, explain: true, budget });

    // One budget source trimmed to a single delivered preference, counting the rest.
    expect(result.preferences.length).toBe(1);
    expect(result.delivery.omittedByBudget).toBe(2);

    // Text and JSON both derive from the SAME result → identical delivered content.
    const envelope = buildContextEnvelope(result, { includeProposed: false, isCanonicalDomain });
    expect(envelope.context.authoritativePreferences.length).toBe(1);
    expect(envelope.meta.diagnostics.omittedByBudget).toBe(2);
    expect(envelope.meta.diagnostics.overflow).toBe(true); // overflow truthfully surfaced

    const block = renderContextBlock(result)!;
    const deliveredRule = result.preferences[0]!.rule;
    expect(block).toContain(deliveredRule);
    expect(envelope.context.authoritativePreferences[0]!.rule).toBe(deliveredRule);
  } finally {
    t.cleanup();
  }
});

test("no budget → full delivery, overflow false in both transports", () => {
  const t = makeTestContext();
  try {
    t.ctx.preferences.remember({ rule: "Always X.", scope: "global", applicability: "always" });
    const result = t.ctx.retrieval.retrieve({ cwd: t.dir, task: "work", track: false, explain: true });
    const envelope = buildContextEnvelope(result, { includeProposed: false, isCanonicalDomain });
    expect(envelope.meta.diagnostics.overflow).toBe(false);
    expect(envelope.meta.diagnostics.delivered).toBe(result.preferences.length);
  } finally {
    t.cleanup();
  }
});

test("a LEGACY oversized rule is bounded in the JSON/MCP envelope (no multi-MB flood)", () => {
  const t = makeTestContext();
  try {
    // Simulate a pre-cap legacy row by inserting directly, bypassing the write schema.
    const huge = "H".repeat(2_000_000); // ~2 MB
    const ts = nowIso();
    t.ctx.db
      .query(
        `INSERT INTO preferences
           (id, rule, normalized, category, domain, polarity, scope, repo_id, status,
            applicability, condition_json, confidence, version, created_at, updated_at, last_used_at, dedup_key)
         VALUES ('legacy1', ?, 'legacy', 'general', NULL, 'neutral', 'global', NULL, 'approved',
            'always', NULL, 1.0, 1, ?, ?, NULL, 'legacy-key')`,
      )
      .run(huge, ts, ts);

    const result = t.ctx.retrieval.retrieve({ cwd: t.dir, task: "work", track: false, explain: true });
    const envelope = buildContextEnvelope(result, { includeProposed: false, isCanonicalDomain });
    const emitted = envelope.context.authoritativePreferences.find((p) => p.rule.startsWith("H"));
    expect(emitted).toBeDefined();
    expect(emitted!.rule.length).toBeLessThanOrEqual(MAX_RULE_CHARS + 1); // bounded, not 2 MB
    // The STORED rule is untouched (we never rewrite user data).
    expect(t.ctx.preferences.getById("legacy1")!.rule.length).toBe(2_000_000);
  } finally {
    t.cleanup();
  }
});
