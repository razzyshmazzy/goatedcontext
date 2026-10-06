import { test, expect } from "bun:test";
import {
  renderMemorySkill,
  renderSkillMd,
  renderProtocolBody,
  ctxCommand,
  extractProtocolBody,
  MEMORY_PROTOCOL_BODY,
} from "../src/core/assets/memory-protocol.ts";
import { CLAUDE_SKILLS } from "../src/adapters/claude/skills.ts";

// Spec §21: the generated memory guidance must spell the ctx launcher correctly for
// the platform. Only the INVOCATION differs; the semantic policy is identical.

const POSIX_CMDS = ["ctx remember", "ctx propose", "ctx prefs", "ctx why", "ctx forget"];
const WIN_CMDS = ["ctx.cmd agent remember", "ctx.cmd agent propose", "ctx.cmd agent signal add", "ctx.cmd prefs", "ctx.cmd why", "ctx.cmd signals"];

test("ctxCommand resolves per platform", () => {
  expect(ctxCommand("win32")).toBe("ctx.cmd");
  expect(ctxCommand("linux")).toBe("ctx");
  expect(ctxCommand("darwin")).toBe("ctx");
});

test("POSIX render contains plain `ctx` commands and NO ctx.cmd / Windows note", () => {
  const skill = renderMemorySkill({ command: "ctx" });
  for (const c of POSIX_CMDS) expect(skill).toContain(c);
  expect(skill).not.toContain("ctx.cmd");
  expect(skill).not.toContain("Invocation on this platform");
});

test("Windows render contains explicit ctx.cmd commands AND the canonical ctx policy", () => {
  const skill = renderMemorySkill({ command: "ctx.cmd" });
  for (const c of WIN_CMDS) expect(skill).toContain(c);
  // The Windows note is present and explains WHY (ps1 shim / execution policy).
  expect(skill).toContain("Invocation on this platform (Windows)");
  expect(skill).toContain("ctx.ps1");
  expect(skill).toContain("execution policy");
  // The canonical policy body is still present (semantics unchanged).
  expect(skill).toContain("# goatedcontext memory protocol");
  expect(skill).toContain("ctx agent remember --origin user --scope");
});

test("default render (no command) is the platform-blind `ctx` body — parity preserved", () => {
  expect(renderMemorySkill()).toBe(renderMemorySkill({ command: "ctx" }));
  expect(extractProtocolBody(renderMemorySkill())).toBe(MEMORY_PROTOCOL_BODY.trim());
  expect(renderProtocolBody("ctx")).toBe(MEMORY_PROTOCOL_BODY);
});

test("the Windows note does NOT change the semantic policy versus POSIX", () => {
  // Stripping the injected note from the Windows body yields the POSIX body exactly.
  const win = renderProtocolBody("ctx.cmd");
  const posix = renderProtocolBody("ctx");
  const note = win.slice(0, win.indexOf("## 1. Durable preference"));
  expect(win.slice(note.length)).toBe(posix.slice(posix.indexOf("## 1. Durable preference")));
});

test("Claude/Codex/Cursor stay byte-identical to each other on a given platform", () => {
  // All three render from the same canonical body; only the command token varies, and
  // it varies identically for each agent on a given host.
  for (const command of ["ctx", "ctx.cmd"]) {
    const codex = extractProtocolBody(renderSkillMd({ name: "goatedcontext", command }));
    const cursor = extractProtocolBody(renderMemorySkill({ command }));
    const claudeLike = extractProtocolBody(renderSkillMd({ name: "context-learn", command }));
    expect(codex).toBe(cursor);
    expect(claudeLike).toBe(cursor);
  }
});

test("Claude's committed context-learn skill stays on plain `ctx` (its exec env differs)", () => {
  // Claude Code runs ctx through its own shell tooling, not PowerShell; leaving its
  // skill platform-blind keeps the committed artifact and distribution stable.
  const learn = CLAUDE_SKILLS.find((s) => s.dir === "context-learn")!.content;
  expect(learn).toContain("ctx remember");
  expect(learn).not.toContain("ctx.cmd");
});
