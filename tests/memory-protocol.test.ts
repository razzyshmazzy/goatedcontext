import { test, expect } from "bun:test";
import {
  MEMORY_PROTOCOL_BODY,
  MEMORY_PROTOCOL_VERSION,
  MEMORY_PROTOCOL_MARKER,
  MEMORY_PROTOCOL_DESCRIPTION,
  CTX_MEMORY_SKILL_NAME,
  renderMemorySkill,
  renderSkillMd,
  extractProtocolBody,
} from "../src/core/assets/memory-protocol.ts";
import { CLAUDE_SKILLS } from "../src/adapters/claude/skills.ts";

const claudeLearn = CLAUDE_SKILLS.find((s) => s.dir === "context-learn")!.content;

// ---- parity: all three agents carry the SAME protocol body -------------------

test("Claude, Codex, and Cursor render the IDENTICAL canonical protocol body", () => {
  const claudeBody = extractProtocolBody(claudeLearn);
  const codexBody = extractProtocolBody(renderMemorySkill()); // Codex + Cursor share this render
  const canonical = MEMORY_PROTOCOL_BODY.trim();
  expect(claudeBody).toBe(canonical);
  expect(codexBody).toBe(canonical);
  // The skill name (folder) differs by host; Codex/Cursor use the shared name.
  expect(CTX_MEMORY_SKILL_NAME).toBe("goatedcontext");
  expect(renderMemorySkill()).toContain("name: goatedcontext");
  expect(claudeLearn).toContain("name: context-learn");
});

test("every rendered artifact carries the version marker for staleness detection", () => {
  expect(MEMORY_PROTOCOL_MARKER).toContain(MEMORY_PROTOCOL_VERSION);
  expect(renderMemorySkill()).toContain(MEMORY_PROTOCOL_MARKER);
  expect(claudeLearn).toContain(MEMORY_PROTOCOL_MARKER);
  expect(renderSkillMd({ name: "x" })).toContain(MEMORY_PROTOCOL_MARKER);
});

test("SKILL.md frontmatter is valid (name + description)", () => {
  const s = renderMemorySkill();
  expect(s.startsWith("---\nname: goatedcontext\ndescription: >-\n")).toBe(true);
  expect(s).toContain(MEMORY_PROTOCOL_DESCRIPTION.slice(0, 40));
  // Body begins after frontmatter.
  expect(s).toContain("\n---\n\n# goatedcontext memory protocol");
});

// ---- deterministic policy content (the guidance teaches the right decisions) --

const body = MEMORY_PROTOCOL_BODY;

test("EXPLICIT durable → ctx remember, with the canonical examples", () => {
  expect(body).toContain("ctx remember");
  expect(body).toContain("Always use Bun in this repo.");
  expect(body).toContain("Never add dependencies without asking.");
  expect(body).toContain("I prefer Postgres"); // relevant example
  // Persistence signals are listed (intent, not keyword-only).
  for (const w of ["always", "never", "from now on", "remember", "prefer", "usually", "in this repo"]) {
    expect(body.toLowerCase()).toContain(w);
  }
  expect(body).toContain("do not ask for redundant");
});

test("SCOPE inference: repo vs global, ambiguous → prefer repo", () => {
  expect(body).toContain("--scope repo");
  expect(body).toContain("--scope global");
  expect(body).toContain("when ambiguous, prefer repo");
  expect(body).toContain("Never silently turn a local convention into a global rule.");
});

test("APPLICABILITY inference: always / conditional / relevant", () => {
  expect(body).toContain("--always");
  expect(body).toContain("--when language=typescript");
  expect(body).toContain("--when file=**/*.tsx");
  expect(body).toContain("--when domain=database");
  expect(body).toContain("default (relevant)");
  expect(body).toContain("Do NOT force every preference into --always.");
});

test("INFERRED → ctx propose, never remember; single request is not evidence", () => {
  expect(body).toContain("ctx propose");
  expect(body).toContain("never `ctx agent remember`");
  expect(body).toContain("A single isolated request is NOT evidence");
});

test("ONE-OFF task instructions → store NOTHING", () => {
  expect(body).toContain("store NOTHING");
  expect(body).toContain("Use Python for this script.");
  expect(body).toContain("Make this function async.");
  expect(body).toContain("never use keyword-only logic");
});

test("RETRACTION → ctx forget (or replace), with safe ambiguity handling", () => {
  expect(body).toContain("ctx forget <id>");
  expect(body).toContain("ctx prefs --json");
  expect(body).toContain("Forget that I prefer Postgres.");
  expect(body).toContain("ask ONE concise clarification");
  expect(body).toContain("Never guess which unrelated memory to");
});

test("SECRETS / task data are NEVER preference-stored", () => {
  expect(body).toContain("NEVER preference-store secrets");
  for (const s of ["passwords", "API keys", "tokens", "private keys", "credentials"]) {
    expect(body).toContain(s);
  }
  expect(body).toContain("Secret VALUES belong only in `ctx env`");
});

test("SILENT operation + non-blocking FAILURE behavior are taught", () => {
  expect(body).toContain("narrate the command");
  expect(body).toContain("memory, not CLI orchestration");
  expect(body).toContain("do NOT fail the developer's task");
  expect(body).toContain("couldn't persist it to ctx");
  // Writes go through the provenance-required AGENT surface, not bare commands.
  expect(body).toContain("`ctx agent remember`");
  expect(body).toContain("`ctx agent propose`");
  expect(body).toContain("`ctx agent signal add`");
  expect(body).toContain("Do NOT use bare `ctx remember`");
});
