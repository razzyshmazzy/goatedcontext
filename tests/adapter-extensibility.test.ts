import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IDS, capabilitiesFor, type AgentCapabilities } from "../src/core/agents/capabilities.ts";
import { planDelivery } from "../src/core/agents/delivery.ts";
import { upsertSkill, skillHealth, removeSkill, skillFile } from "../src/core/assets/skill-install.ts";
import { renderMemorySkill } from "../src/core/assets/memory-protocol.ts";
import { upsertManagedBlock, removeManagedBlock, hasManagedBlock } from "../src/utils/managed-block.ts";

/**
 * Adapter extensibility evidence (0.3.0 diagnostic). Two parts:
 *  1. A parity matrix over the THREE real agents, asserting capability-appropriate
 *     behavior (we test EXPECTED capabilities, not identical method sets).
 *  2. A TEST-ONLY "fourth agent" assembled from the shared primitives, to measure
 *     how reusable the core is and exactly what a new agent still forces.
 */

// ── Part 1: capability parity matrix ─────────────────────────────────────────

test("every registered agent exposes a complete capability profile", () => {
  for (const id of AGENT_IDS) {
    const c = capabilitiesFor(id);
    // All capability flags are present booleans (no undefined holes).
    for (const k of Object.keys(c) as (keyof AgentCapabilities)[]) expect(typeof c[k]).toBe("boolean");
    // Every supported agent can host the memory-WRITE skill.
    expect(c.memorySkill).toBe(true);
  }
});

test("delivery routing matches each agent's declared capabilities (static/runtime/unsupported)", () => {
  // One repo-always rule + one global-relevant rule, routed per agent.
  const prefs = [
    { id: "repoAlways", scope: "repo", status: "approved", applicability: "always" },
    { id: "globalRelevant", scope: "global", status: "approved", applicability: "relevant" },
  ];
  // Claude: no static → everything runtime.
  const claude = planDelivery(capabilitiesFor("claude"), prefs);
  expect(claude.static).toEqual([]);
  expect(claude.runtime.sort()).toEqual(["globalRelevant", "repoAlways"]);
  // Codex: repo-always static, relevant runtime.
  const codex = planDelivery(capabilitiesFor("codex"), prefs);
  expect(codex.static).toEqual(["repoAlways"]);
  expect(codex.runtime).toEqual(["globalRelevant"]);
  // Cursor: repo-always static, relevant UNSUPPORTED (no runtime injection) — never broadened.
  const cursor = planDelivery(capabilitiesFor("cursor"), prefs);
  expect(cursor.static).toEqual(["repoAlways"]);
  expect(cursor.runtime).toEqual([]);
  expect(cursor.unsupported).toEqual(["globalRelevant"]);
});

// ── Part 2: a fourth agent built ONLY from shared primitives ─────────────────
//
// This proves the CORE building blocks (skill install/health, delivery planner,
// managed-block projection) are agent-neutral and reusable with zero core edits.
// The friction that REMAINS (and would need real production edits for a shipped
// agent) is enumerated in the final assertion / diagnostic report:
//   - capabilities.ts: AgentId union + capabilitiesFor() switch (compile-time)
//   - registry.ts: LABELS, STATUS_FNS, a <agent>Status() function
//   - cli/index.ts: install/uninstall/repair/agents target branches
//   - cli/setup.ts: auto-detect wiring
// None of those are needed to REUSE the engine — only to register a first-class agent.

interface FakeCaps extends AgentCapabilities {}
const FAKE_CAPS: FakeCaps = {
  runtimePromptInjection: true,
  staticAgentsMd: true,
  staticCursorRules: false,
  cwdAvailable: true,
  promptAvailable: true,
  fileContextAvailable: false,
  sessionInjection: false,
  memorySkill: true,
  nativeHooks: true,
  mcp: false,
  permissionIntegration: false,
};

test("a fourth agent installs/repairs/uninstalls its memory skill via shared primitives (no core edits)", () => {
  const home = mkdtempSync(join(tmpdir(), "ctx-fake-agent-"));
  try {
    const NAME = "goatedcontext"; // shared skill name
    const content = renderMemorySkill({ command: "ctx" });

    // install
    expect(upsertSkill(home, NAME, content)).toBe("created");
    expect(existsSync(skillFile(home, NAME))).toBe(true);
    expect(skillHealth(home, NAME, content)).toBe("current");
    // repair (idempotent)
    expect(upsertSkill(home, NAME, content)).toBe("unchanged");
    // stale detection
    upsertSkill(home, NAME, "stale\n");
    expect(skillHealth(home, NAME, content)).toBe("stale");
    expect(upsertSkill(home, NAME, content)).toBe("updated");
    // uninstall
    expect(removeSkill(home, NAME)).toBe("removed");
    expect(skillHealth(home, NAME, content)).toBe("missing");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a fourth agent projects a static block via the shared managed-block writer", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-fake-proj-"));
  const file = join(dir, "FAKEAGENT.md");
  const BEGIN = "<!-- fake:begin -->";
  const END = "<!-- fake:end -->";
  try {
    const block = `${BEGIN}\n- always run the linter\n${END}`;
    expect(upsertManagedBlock(file, BEGIN, END, block)).toBe("created");
    expect(hasManagedBlock(file, BEGIN, END)).toBe(true);
    expect(upsertManagedBlock(file, BEGIN, END, block)).toBe("unchanged"); // idempotent
    expect(removeManagedBlock(file, BEGIN, END)).toBe("removed");
    expect(hasManagedBlock(file, BEGIN, END)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fourth agent's delivery routing is fully determined by its capability object", () => {
  const prefs = [
    { id: "repoAlways", scope: "repo", status: "approved", applicability: "always" },
    { id: "globalAlways", scope: "global", status: "approved", applicability: "always" },
    { id: "conditional", scope: "global", status: "approved", applicability: "conditional" },
    { id: "proposed", scope: "global", status: "proposed", applicability: "always" },
  ];
  const plan = planDelivery(FAKE_CAPS, prefs);
  expect(plan.static).toEqual(["repoAlways"]); // AGENTS.md-capable → repo-always is static
  expect(plan.runtime.sort()).toEqual(["conditional", "globalAlways"]); // injectable → runtime
  expect(plan.unsupported).toEqual([]);
  expect(plan.static.concat(plan.runtime)).not.toContain("proposed"); // non-active excluded
});
