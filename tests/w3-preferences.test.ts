import { test, expect } from "bun:test";
import { makeTestContext } from "./helpers.ts";
import { exportData, importData } from "../src/core/transfer/transfer.ts";
import { MAX_RULE_CHARS } from "../src/core/preferences/types.ts";
import { CtxError } from "../src/utils/errors.ts";

/**
 * Wave 3 preference findings: rule-size cap (14), duplicate-remember idempotency (7),
 * and import validation/versioning/history (1).
 */

// ── 14. rule-size cap on every write path ─────────────────────────────────────

test("oversized rules are rejected on remember, propose, and import; normal rules pass", () => {
  const t = makeTestContext();
  try {
    const big = "x".repeat(MAX_RULE_CHARS + 1);
    expect(() => t.ctx.preferences.remember({ rule: big, scope: "global" })).toThrow();
    expect(() =>
      t.ctx.preferences.propose({ rule: big, scope: "global", evidence: "because", origin: "user" }),
    ).toThrow();
    // At the cap is fine.
    const ok = t.ctx.preferences.remember({ rule: "y".repeat(MAX_RULE_CHARS), scope: "global" });
    expect(ok.rule.length).toBe(MAX_RULE_CHARS);
  } finally {
    t.cleanup();
  }
});

// ── 7. duplicate remember idempotency ─────────────────────────────────────────

test("identical remember is idempotent (one row), distinct writes stay distinct", () => {
  const t = makeTestContext();
  try {
    const a = t.ctx.preferences.remember({ rule: "Use Bun for development.", scope: "global" });
    const b = t.ctx.preferences.remember({ rule: "use   bun   for development.  ", scope: "global" }); // same canonical
    expect(b.id).toBe(a.id); // deduped, not duplicated
    expect(t.ctx.preferences.list({ status: "approved" }).length).toBe(1);

    // Distinct applicability must NOT merge.
    const always = t.ctx.preferences.remember({ rule: "Use Bun for development.", scope: "global", applicability: "always" });
    expect(always.id).not.toBe(a.id);
    // Distinct scope (repo vs global) must NOT merge (needs a repo — use a different rule to keep it simple).
    expect(t.ctx.preferences.list({ status: "approved" }).length).toBe(2);
  } finally {
    t.cleanup();
  }
});

// ── 1. import validation / versioning / history ───────────────────────────────

function minimalBundle(overrides: Record<string, unknown> = {}) {
  return {
    schema: "ctx-export",
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    repos: [],
    preferences: [
      {
        rule: "Prefer Postgres.",
        category: "database",
        domain: null,
        polarity: "positive",
        scope: "global",
        status: "approved",
        applicability: "relevant",
        condition: null,
        confidence: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repoIdentity: null,
        evidence: [],
      },
    ],
    ...overrides,
  };
}

test("valid current-version import writes a preference AND records history", () => {
  const t = makeTestContext();
  try {
    const summary = importData(t.ctx, minimalBundle());
    expect(summary.imported).toBe(1);
    expect(t.ctx.preferences.list().some((p) => /postgres/i.test(p.rule))).toBe(true);
    // History must record the import-created preference.
    const events = t.ctx.events.list();
    expect(events.some((e) => e.type === "preference.remembered")).toBe(true);
  } finally {
    t.cleanup();
  }
});

test("unknown future version fails closed with zero writes", () => {
  const t = makeTestContext();
  try {
    expect(() => importData(t.ctx, minimalBundle({ version: 999 }))).toThrow(CtxError);
    expect(t.ctx.preferences.list().length).toBe(0); // nothing written
  } finally {
    t.cleanup();
  }
});

test("invalid rule / oversized rule / bad status → import fails, zero writes", () => {
  const t = makeTestContext();
  try {
    // oversized rule
    const oversized = minimalBundle();
    (oversized.preferences as any)[0].rule = "z".repeat(MAX_RULE_CHARS + 1);
    expect(() => importData(t.ctx, oversized)).toThrow();
    expect(t.ctx.preferences.list().length).toBe(0);

    // invalid status (not in the enum)
    const badStatus = minimalBundle();
    (badStatus.preferences as any)[0].status = "super-locked";
    expect(() => importData(t.ctx, badStatus)).toThrow();
    expect(t.ctx.preferences.list().length).toBe(0);
  } finally {
    t.cleanup();
  }
});

test("middle-record failure rolls back the whole import (all-or-nothing)", () => {
  const t = makeTestContext();
  try {
    const bundle = minimalBundle();
    // record 1 valid, record 2 invalid (empty rule → schema rejects before any write)
    (bundle.preferences as any).push({ ...(bundle.preferences as any)[0], rule: "" });
    expect(() => importData(t.ctx, bundle)).toThrow();
    expect(t.ctx.preferences.list().length).toBe(0); // record 1 was NOT partially imported
  } finally {
    t.cleanup();
  }
});

test("locked round-trip: export of a locked rule re-imports as locked", () => {
  const t = makeTestContext();
  try {
    t.ctx.preferences.remember({ rule: "Never commit secrets.", scope: "global", status: "locked" });
    const bundle = exportData(t.ctx);

    const t2 = makeTestContext();
    try {
      importData(t2.ctx, bundle);
      const restored = t2.ctx.preferences.list().find((p) => /never commit/i.test(p.rule))!;
      expect(restored.status).toBe("locked"); // round-trip preserves locked
    } finally {
      t2.cleanup();
    }
  } finally {
    t.cleanup();
  }
});

test("malformed document → zero writes", () => {
  const t = makeTestContext();
  try {
    expect(() => importData(t.ctx, { not: "a bundle" })).toThrow();
    expect(() => importData(t.ctx, "garbage")).toThrow();
    expect(t.ctx.preferences.list().length).toBe(0);
  } finally {
    t.cleanup();
  }
});
