import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaude } from "../src/adapters/claude/installer.ts";
import { CTX_INSTRUCTION_BEGIN } from "../src/adapters/claude/skills.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ctx-claude-"));
}

test("installer writes the three skills and a global instruction block", () => {
  const home = tmp();
  const result = installClaude({ claudeHome: home });
  expect(result.installedSkills.sort()).toEqual(["context", "context-env", "context-learn"]);
  for (const skill of ["context", "context-learn", "context-env"]) {
    expect(existsSync(join(home, "skills", skill, "SKILL.md"))).toBe(true);
  }
  expect(result.instructionsAction).toBe("created");
  expect(readFileSync(result.instructionsFile, "utf8")).toContain(CTX_INSTRUCTION_BEGIN);
  rmSync(home, { recursive: true, force: true });
});

test("running the installer twice does not duplicate the instruction block", () => {
  const home = tmp();
  installClaude({ claudeHome: home });
  const second = installClaude({ claudeHome: home });
  expect(second.instructionsAction).toBe("unchanged");
  const content = readFileSync(second.instructionsFile, "utf8");
  const occurrences = content.split(CTX_INSTRUCTION_BEGIN).length - 1;
  expect(occurrences).toBe(1);
  rmSync(home, { recursive: true, force: true });
});

test("installer preserves unrelated existing user instructions", () => {
  const home = tmp();
  const file = join(home, "CLAUDE.md");
  // Pre-existing instructions the user wrote themselves.
  require("node:fs").mkdirSync(home, { recursive: true });
  writeFileSync(file, "# My rules\n\nAlways write tests.\n", "utf8");
  installClaude({ claudeHome: home });
  const content = readFileSync(file, "utf8");
  expect(content).toContain("Always write tests.");
  expect(content).toContain(CTX_INSTRUCTION_BEGIN);
  rmSync(home, { recursive: true, force: true });
});

test("installer refreshes an existing block in place without duplicating", () => {
  const home = tmp();
  installClaude({ claudeHome: home });
  const file = join(home, "CLAUDE.md");
  // Simulate user text added after the block; it must survive re-install.
  const withExtra = readFileSync(file, "utf8") + "\n## User note\nkeep me\n";
  writeFileSync(file, withExtra, "utf8");
  installClaude({ claudeHome: home });
  const content = readFileSync(file, "utf8");
  expect(content.split(CTX_INSTRUCTION_BEGIN).length - 1).toBe(1);
  expect(content).toContain("keep me");
  rmSync(home, { recursive: true, force: true });
});
