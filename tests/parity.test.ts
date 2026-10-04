import { test, expect } from "bun:test";
import { makeTestContext, makeGitRepo } from "./helpers.ts";
import { planDelivery } from "../src/core/agents/delivery.ts";
import { capabilitiesFor } from "../src/core/agents/capabilities.ts";
import { selectStaticPreferences } from "../src/core/project/projection.ts";
import { simulateAgent } from "../src/adapters/test-hook.ts";
import type { Preference } from "../src/core/preferences/types.ts";

// Canonical cross-agent fixture (spec §14). ONE dataset, asserted per agent:
//   semantic coverage must be correct — no duplicates, no broadening.

const GLOBAL_ALWAYS = "Never add dependencies without asking.";
const REPO_ALWAYS = "Use Bun for development commands.";
const RELEVANT = "Prefer foreign keys for relational integrity.";
const CONDITIONAL = "Use strict TypeScript.";

function fixture() {
  const t = makeTestContext();
  const repo = makeGitRepo();
  const r = t.ctx.repos.resolve(repo.root)!;
  const ids = {
    globalAlways: t.ctx.preferences.remember({ rule: GLOBAL_ALWAYS, scope: "global", applicability: "always" }).id,
    repoAlways: t.ctx.preferences.remember({ rule: REPO_ALWAYS, scope: "repo", repoId: r.id, applicability: "always", domain: "package-manager", category: "dependencies" }).id,
    relevant: t.ctx.preferences.remember({ rule: RELEVANT, scope: "global", category: "database" }).id,
    conditional: t.ctx.preferences.remember({ rule: CONDITIONAL, scope: "global", condition: { language: "typescript" } }).id,
  };
  const active: Preference[] = t.ctx.preferences.list().filter((p) => p.status === "approved" || p.status === "locked");
  return { t, repo, r, ids, active };
}

function rulesOf(ids: string[], active: Preference[]): string[] {
  const byId = new Map(active.map((p) => [p.id, p.rule]));
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

test("CODEX: repo-always static only; global-always/relevant/conditional runtime (no duplicate)", () => {
  const { t, repo, ids, active } = fixture();
  try {
    const plan = planDelivery(capabilitiesFor("codex"), active);
    expect(rulesOf(plan.static, active)).toEqual([REPO_ALWAYS]);
    expect(rulesOf(plan.runtime, active).sort()).toEqual([GLOBAL_ALWAYS, RELEVANT, CONDITIONAL].sort());
    expect(plan.unsupported).toEqual([]);
    // repo-always is NOT also in runtime — delivered exactly once.
    expect(plan.runtime).not.toContain(ids.repoAlways);

    // The repo's static materialization is exactly the repo-always rule.
    expect(selectStaticPreferences(t.ctx, repo.root).preferences.map((p) => p.rule)).toEqual([REPO_ALWAYS]);
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});

test("CURSOR: repo-always static; all dynamic rules unsupported (never broadened)", () => {
  const { t, repo, active } = fixture();
  try {
    const plan = planDelivery(capabilitiesFor("cursor"), active);
    expect(rulesOf(plan.static, active)).toEqual([REPO_ALWAYS]);
    expect(plan.runtime).toEqual([]);
    expect(rulesOf(plan.unsupported, active).sort()).toEqual([GLOBAL_ALWAYS, RELEVANT, CONDITIONAL].sort());
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});

test("CLAUDE: everything runtime (incl. repo-always); nothing static", () => {
  const { t, repo, active } = fixture();
  try {
    const plan = planDelivery(capabilitiesFor("claude"), active);
    expect(plan.static).toEqual([]);
    expect(rulesOf(plan.runtime, active).sort()).toEqual([GLOBAL_ALWAYS, REPO_ALWAYS, RELEVANT, CONDITIONAL].sort());
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});

test("Codex runtime hook dedup: a repo-always rule reaches Codex exactly once (not in the injected block)", () => {
  const { t, repo } = fixture();
  try {
    // A TS database task so the relevant + conditional rules both surface at runtime.
    const sim = simulateAgent(t.ctx, {
      agent: "codex",
      cwd: repo.root,
      task: "design the database schema",
      files: ["db/schema.ts"],
    });
    const injected = sim.preferences.map((p) => p.rule);
    expect(injected).not.toContain(REPO_ALWAYS); // deduped — it's in AGENTS.md instead
    expect(injected).toContain(GLOBAL_ALWAYS); // global always → runtime
    // The static plan still lists the repo-always rule (delivered via AGENTS.md).
    expect(sim.plan.static.map((e) => e.rule)).toContain(REPO_ALWAYS);
    expect(sim.block).not.toContain(REPO_ALWAYS);
    expect(sim.block).toContain(GLOBAL_ALWAYS);
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});

test("Claude runtime hook includes the repo-always rule (no static dedup for Claude)", () => {
  const { t, repo } = fixture();
  try {
    const sim = simulateAgent(t.ctx, { agent: "claude", cwd: repo.root, task: "design the database schema", files: ["db/schema.ts"] });
    expect(sim.preferences.map((p) => p.rule)).toContain(REPO_ALWAYS);
    expect(sim.block).toContain(REPO_ALWAYS);
    expect(sim.plan.static).toEqual([]);
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});

test("Cursor simulation is honest: runtime unsupported, no fabricated block", () => {
  const { t, repo } = fixture();
  try {
    const sim = simulateAgent(t.ctx, { agent: "cursor", cwd: repo.root, task: "design the database schema", files: ["db/schema.ts"] });
    expect(sim.runtimeSupported).toBe(false);
    expect(sim.block).toBeNull();
    expect(sim.preferences).toEqual([]);
    expect(sim.plan.static.map((e) => e.rule)).toEqual([REPO_ALWAYS]); // only what AGENTS.md carries
    expect(sim.plan.unsupported.map((e) => e.rule).sort()).toEqual([GLOBAL_ALWAYS, RELEVANT, CONDITIONAL].sort());
  } finally {
    repo.cleanup();
    t.cleanup();
  }
});
