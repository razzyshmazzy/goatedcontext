import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_SKILLS } from "../src/adapters/claude/skills.ts";
import {
  MEMORY_PROTOCOL_MARKER,
  extractProtocolBody,
  renderMemorySkill,
} from "../src/core/assets/memory-protocol.ts";

/**
 * Skill-generation parity / drift guard (0.3.0 diagnostic). Semantic body parity
 * across agents and the version marker are covered by memory-protocol.test.ts and
 * command-invocation.test.ts; this adds the MISSING guard: committed skills/*.md
 * artifacts must equal what the generator produces (no stale committed files).
 */

const ROOT = join(import.meta.dir, "..");

test("committed skills/<name>/SKILL.md match the generator exactly (no drift)", () => {
  for (const skill of CLAUDE_SKILLS) {
    const file = join(ROOT, "skills", skill.dir, "SKILL.md");
    if (!existsSync(file)) {
      // Not every generated skill is necessarily committed; only assert the ones that are.
      continue;
    }
    expect(readFileSync(file, "utf8")).toBe(skill.content);
  }
});

test("the canonical protocol body is identical across Claude/Codex/Cursor on a platform", () => {
  const codexCursor = extractProtocolBody(renderMemorySkill({ command: "ctx" }));
  const claude = extractProtocolBody(CLAUDE_SKILLS.find((s) => s.dir === "context-learn")!.content);
  expect(claude).toBe(codexCursor);
  // Every rendered artifact carries the staleness marker.
  expect(renderMemorySkill({ command: "ctx" })).toContain(MEMORY_PROTOCOL_MARKER);
  expect(renderMemorySkill({ command: "ctx.cmd" })).toContain(MEMORY_PROTOCOL_MARKER);
});

test("only the command invocation differs by platform — the policy text is otherwise identical", () => {
  const posix = extractProtocolBody(renderMemorySkill({ command: "ctx" }));
  const win = extractProtocolBody(renderMemorySkill({ command: "ctx.cmd" }));
  // Remove the Windows-only invocation note; the remainder must match POSIX byte-for-byte.
  const marker = "## 1. Durable preference";
  expect(win.slice(win.indexOf(marker))).toBe(posix.slice(posix.indexOf(marker)));
});
