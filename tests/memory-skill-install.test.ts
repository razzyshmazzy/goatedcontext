import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCodex, repairCodex, uninstallCodex, codexSkillHealth } from "../src/adapters/codex/installer.ts";
import {
  installCursorSkill,
  repairCursorSkill,
  uninstallCursorSkill,
  cursorSkillHealth,
} from "../src/adapters/cursor/installer.ts";
import { installClaude } from "../src/adapters/claude/installer.ts";
import { renderMemorySkill, ctxCommand } from "../src/core/assets/memory-protocol.ts";

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
const skillPath = (home: string) => join(home, "skills", "goatedcontext", "SKILL.md");
// Installers render the skill for the HOST platform (ctx on POSIX, ctx.cmd on Windows);
// compare against the same platform-aware render.
const hostSkill = () => renderMemorySkill({ command: ctxCommand() });

// ---- Codex memory skill ------------------------------------------------------

test("Codex: install writes a valid SKILL.md; repair is idempotent; uninstall removes it", () => {
  const home = dir("ctx-codex-skill-");
  try {
    const r = installCodex({ home });
    expect(r.skillAction).toBe("created");
    expect(existsSync(skillPath(home))).toBe(true);
    expect(readFileSync(skillPath(home), "utf8")).toBe(hostSkill());
    expect(codexSkillHealth(home)).toBe("current");

    // Repair converges with no churn.
    expect(repairCodex({ home }).skillAction).toBe("unchanged");

    const u = uninstallCodex({ home });
    expect(u.skillAction).toBe("removed");
    expect(existsSync(skillPath(home))).toBe(false);
    expect(codexSkillHealth(home)).toBe("missing");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex: a STALE skill is detected and repair rewrites it", () => {
  const home = dir("ctx-codex-stale-");
  try {
    mkdirSync(join(home, "skills", "goatedcontext"), { recursive: true });
    writeFileSync(skillPath(home), "---\nname: goatedcontext\ndescription: old\n---\n\nstale body\n");
    expect(codexSkillHealth(home)).toBe("stale");
    expect(installCodex({ home }).skillAction).toBe("updated");
    expect(codexSkillHealth(home)).toBe("current");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex: uninstall removes ONLY our skill, preserving unrelated skills", () => {
  const home = dir("ctx-codex-preserve-");
  try {
    mkdirSync(join(home, "skills", "other-tool"), { recursive: true });
    writeFileSync(join(home, "skills", "other-tool", "SKILL.md"), "---\nname: other-tool\ndescription: x\n---\n");
    installCodex({ home });
    uninstallCodex({ home });
    expect(existsSync(join(home, "skills", "goatedcontext"))).toBe(false);
    expect(existsSync(join(home, "skills", "other-tool", "SKILL.md"))).toBe(true); // preserved
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex: CODEX_HOME env selects the skills root", () => {
  const home = dir("ctx-codex-env-");
  try {
    const r = installCodex({ env: { ...process.env, CODEX_HOME: home } });
    expect(r.home).toBe(home);
    expect(existsSync(skillPath(home))).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- Cursor memory skill -----------------------------------------------------

test("Cursor: install writes ~/.cursor/skills/goatedcontext/SKILL.md; repair idempotent; uninstall removes", () => {
  const home = dir("ctx-cursor-skill-");
  try {
    const r = installCursorSkill({ home });
    expect(r.skillAction).toBe("created");
    expect(readFileSync(skillPath(home), "utf8")).toBe(hostSkill());
    expect(cursorSkillHealth({ home })).toBe("current");
    expect(repairCursorSkill({ home }).skillAction).toBe("unchanged");

    const u = uninstallCursorSkill({ home });
    expect(u.skillAction).toBe("removed");
    expect(existsSync(skillPath(home))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Cursor: uninstall preserves unrelated user skills", () => {
  const home = dir("ctx-cursor-preserve-");
  try {
    mkdirSync(join(home, "skills", "my-skill"), { recursive: true });
    writeFileSync(join(home, "skills", "my-skill", "SKILL.md"), "---\nname: my-skill\ndescription: x\n---\n");
    installCursorSkill({ home });
    uninstallCursorSkill({ home });
    expect(existsSync(join(home, "skills", "goatedcontext"))).toBe(false);
    expect(existsSync(join(home, "skills", "my-skill", "SKILL.md"))).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- Claude memory skill (context-learn) ------------------------------------

test("Claude: install writes the canonical protocol as the context-learn skill", () => {
  const home = dir("ctx-claude-skill-");
  try {
    installClaude({ claudeHome: home });
    const file = join(home, "skills", "context-learn", "SKILL.md");
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf8");
    expect(content).toContain("# goatedcontext memory protocol");
    expect(content).toContain("ctx remember");
    expect(content).toContain("ctx forget <id>");
    expect(content).toContain("<!-- ctx-memory-protocol:");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
