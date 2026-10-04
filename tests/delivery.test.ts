import { test, expect } from "bun:test";
import { planDelivery, type DeliverablePref } from "../src/core/agents/delivery.ts";
import {
  CLAUDE_CAPABILITIES,
  CODEX_CAPABILITIES,
  CURSOR_CAPABILITIES,
  AGENTS_FILE_CAPABILITIES,
} from "../src/core/agents/capabilities.ts";

// The delivery planner is the single policy source for static/runtime/unsupported.
// It is pure, so it gets exhaustive unit tests.

let n = 0;
function p(partial: Partial<DeliverablePref>): DeliverablePref {
  return { id: `p${++n}`, scope: "global", status: "approved", applicability: "relevant", ...partial };
}

const repoAlways = () => p({ scope: "repo", status: "approved", applicability: "always" });
const repoLockedAlways = () => p({ scope: "repo", status: "locked", applicability: "always" });
const globalAlways = () => p({ scope: "global", status: "approved", applicability: "always" });
const relevant = () => p({ scope: "global", status: "approved", applicability: "relevant" });
const repoRelevant = () => p({ scope: "repo", status: "approved", applicability: "relevant" });
const conditional = () => p({ scope: "repo", status: "approved", applicability: "conditional" });

function buckets(caps: Parameters<typeof planDelivery>[0], prefs: DeliverablePref[]) {
  const plan = planDelivery(caps, prefs);
  return plan;
}

test("a plain AGENTS.md file materializes ONLY repo approved/locked always", () => {
  const ra = repoAlways(), rla = repoLockedAlways(), ga = globalAlways(), rel = relevant(), rr = repoRelevant(), c = conditional();
  const plan = buckets(AGENTS_FILE_CAPABILITIES, [ra, rla, ga, rel, rr, c]);
  expect(plan.static.sort()).toEqual([ra.id, rla.id].sort());
  // Everything else is unsupported for a static file (no runtime injection).
  expect(plan.runtime).toEqual([]);
  expect(plan.unsupported.sort()).toEqual([ga.id, rel.id, rr.id, c.id].sort());
});

test("Codex (static AGENTS.md + runtime): repo-always static; everything else runtime", () => {
  const ra = repoAlways(), ga = globalAlways(), rel = relevant(), c = conditional();
  const plan = buckets(CODEX_CAPABILITIES, [ra, ga, rel, c]);
  expect(plan.static).toEqual([ra.id]);
  expect(plan.runtime.sort()).toEqual([ga.id, rel.id, c.id].sort());
  expect(plan.unsupported).toEqual([]);
});

test("Claude (runtime, no AGENTS.md projection): everything active is runtime, nothing static", () => {
  const ra = repoAlways(), ga = globalAlways(), rel = relevant(), c = conditional();
  const plan = buckets(CLAUDE_CAPABILITIES, [ra, ga, rel, c]);
  expect(plan.static).toEqual([]);
  expect(plan.runtime.sort()).toEqual([ra.id, ga.id, rel.id, c.id].sort());
  expect(plan.unsupported).toEqual([]);
});

test("Cursor (static only, no runtime): repo-always static; dynamic rules UNSUPPORTED, never broadened", () => {
  const ra = repoAlways(), ga = globalAlways(), rel = relevant(), c = conditional(), rr = repoRelevant();
  const plan = buckets(CURSOR_CAPABILITIES, [ra, ga, rel, c, rr]);
  expect(plan.static).toEqual([ra.id]);
  expect(plan.runtime).toEqual([]); // no runtime channel
  // global always, relevant, conditional, repo-relevant are all unsupported — NOT static.
  expect(plan.unsupported.sort()).toEqual([ga.id, rel.id, c.id, rr.id].sort());
});

test("proposed/observed/rejected are excluded from EVERY bucket", () => {
  const proposed = p({ scope: "repo", status: "proposed", applicability: "always" });
  const observed = p({ scope: "repo", status: "observed", applicability: "always" });
  const rejected = p({ scope: "repo", status: "rejected", applicability: "always" });
  for (const caps of [CODEX_CAPABILITIES, CLAUDE_CAPABILITIES, CURSOR_CAPABILITIES, AGENTS_FILE_CAPABILITIES]) {
    const plan = planDelivery(caps, [proposed, observed, rejected]);
    const all = [...plan.static, ...plan.runtime, ...plan.unsupported];
    expect(all).toEqual([]);
  }
});

test("no preference is ever delivered to the same agent both statically and at runtime", () => {
  const prefs = [repoAlways(), repoLockedAlways(), globalAlways(), relevant(), repoRelevant(), conditional()];
  for (const caps of [CODEX_CAPABILITIES, CLAUDE_CAPABILITIES, CURSOR_CAPABILITIES, AGENTS_FILE_CAPABILITIES]) {
    const plan = planDelivery(caps, prefs);
    const inStatic = new Set(plan.static);
    expect(plan.runtime.some((id) => inStatic.has(id))).toBe(false);
    // Buckets are disjoint overall.
    const union = [...plan.static, ...plan.runtime, ...plan.unsupported];
    expect(new Set(union).size).toBe(union.length);
  }
});
