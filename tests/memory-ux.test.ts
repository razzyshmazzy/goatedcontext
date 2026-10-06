import { test, expect } from "bun:test";
import {
  MEMORY_PROTOCOL_BODY,
  MEMORY_PROTOCOL_DESCRIPTION,
  renderMemorySkill,
  extractProtocolBody,
} from "../src/core/assets/memory-protocol.ts";
import { CLAUDE_SKILLS } from "../src/adapters/claude/skills.ts";

/**
 * Memory-UX guidance (0.3.x polish). Deterministic guards over the ONE canonical
 * memory-protocol body: the acknowledgement must match the scope actually written,
 * an explicit durable write takes the one-command fast path with no pre-reads, a
 * one-off stores nothing, and the policy stays identical across agents/platforms.
 * These assert the installed GUIDANCE text (what routes the agent), not a live LLM.
 */

const body = MEMORY_PROTOCOL_BODY;

/** Slice the body for one `## N.` section so an assertion can scope to it. */
function section(n: number): string {
  const start = body.indexOf(`## ${n}.`);
  const end = body.indexOf(`## ${n + 1}.`);
  return body.slice(start, end === -1 ? undefined : end);
}

// 1. Repo-scope acknowledgement must never claim a broader reach.
test("repo-scope acknowledgement guidance forbids cross-project / future-project wording", () => {
  expect(body).toContain('"Saved for this repository."');
  // The prohibition is explicitly bound to `--scope repo`.
  expect(body).toContain("With `--scope repo`, never say");
  expect(body).toContain('"for future projects"');
  expect(body).toContain('"across projects"');
  expect(body).toContain('"as your general default"');
  // The command result (echoed scope) is authoritative — no broader claims than written.
  expect(body).toContain("scope=");
  expect(body).toContain("never claim a broader reach than you wrote");
});

// 2. Global-scope acknowledgement MAY use cross-project wording.
test("global-scope acknowledgement guidance permits cross-project wording", () => {
  expect(body).toContain('"Saved as your general preference."');
  expect(body).toContain("across your projects");
  // Conditional writes name the condition.
  expect(body).toContain('"Saved for TypeScript work."');
});

// 3. An explicit durable preference takes the ONE-command fast path.
test("explicit durable guidance directs exactly ONE ctx remember on the fast path", () => {
  expect(body).toContain("run exactly ONE `ctx agent remember --origin user`");
  expect(body).toContain("ctx agent remember --origin user --scope <global|repo>");
  // Inferred vs explicit split is preserved (one propose for inferred).
  expect(body).toContain("ctx agent propose --origin user --evidence");
});

// 4. A one-off instruction stores NOTHING — no write command in that section.
test("one-off guidance stores nothing (no remember/propose in the one-off section)", () => {
  const oneOff = section(3);
  expect(oneOff).toContain("store NOTHING");
  expect(oneOff).not.toContain("ctx remember");
  expect(oneOff).not.toContain("ctx propose");
});

// 5. No inspection/pre-read before a straightforward new write.
test("guidance forbids a prefs/why pre-read before an unambiguous new write", () => {
  expect(body).toContain("Do NOT first run `ctx prefs`");
  expect(body).toContain("`ctx why`, or any inspection");
  expect(body).toContain("do not narrate"); // no tool-selection narration
});

// 6. One canonical policy — identical across Claude / Codex / Cursor.
test("Claude, Codex, and Cursor share the identical canonical policy body", () => {
  const claude = extractProtocolBody(CLAUDE_SKILLS.find((s) => s.dir === "context-learn")!.content);
  const codexCursor = extractProtocolBody(renderMemorySkill()); // Codex + Cursor share this render
  expect(claude).toBe(codexCursor);
  expect(claude).toBe(body.trim());
  // The discovery description front-loads the trigger + the one-command action.
  expect(MEMORY_PROTOCOL_DESCRIPTION).toContain("state, change, or revoke");
  expect(MEMORY_PROTOCOL_DESCRIPTION).toContain("one `ctx agent remember --origin user`");
  expect(MEMORY_PROTOCOL_DESCRIPTION).not.toContain("\n"); // single line for YAML folding
});

// 7. Windows invocation uses ctx.cmd.
test("Windows render invokes ctx.cmd for every memory command", () => {
  const win = renderMemorySkill({ command: "ctx.cmd" });
  for (const c of ["ctx.cmd agent remember", "ctx.cmd agent propose", "ctx.cmd agent signal add", "ctx.cmd prefs", "ctx.cmd why", "ctx.cmd signals"]) {
    expect(win).toContain(c);
  }
});

// 8. POSIX invocation uses plain ctx (and never ctx.cmd).
test("POSIX render invokes plain ctx and never ctx.cmd", () => {
  const posix = renderMemorySkill({ command: "ctx" });
  expect(posix).toContain("ctx agent remember --origin user --scope");
  expect(posix).not.toContain("ctx.cmd");
});
