import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../utils/fs.ts";

/**
 * Shared install/repair/remove logic for an Agent-Skills `SKILL.md` skill directory
 * (`<home>/skills/<name>/SKILL.md`). Codex and Cursor both adopt this open standard,
 * so they share one implementation; the goatedcontext memory-protocol skill is the
 * only skill we own. We touch ONLY our own `<name>` directory — unrelated skills are
 * never read or modified.
 */

export type SkillAction = "created" | "updated" | "unchanged";
export type SkillRemoveAction = "removed" | "absent";

/** Absolute path of our SKILL.md under a skills root home (e.g. `~/.codex`, `~/.cursor`). */
export function skillFile(home: string, name: string): string {
  return join(home, "skills", name, "SKILL.md");
}

/** The `<name>` skill directory (what uninstall removes). */
export function skillDir(home: string, name: string): string {
  return join(home, "skills", name);
}

/** Write/refresh the skill's SKILL.md atomically, reporting what changed. */
export function upsertSkill(home: string, name: string, content: string): SkillAction {
  const dir = skillDir(home, name);
  const file = skillFile(home, name);
  if (existsSync(file)) {
    try {
      if (readFileSync(file, "utf8") === content) return "unchanged";
    } catch {
      /* unreadable — fall through and rewrite */
    }
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(file, content, 0o644);
    return "updated";
  }
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(file, content, 0o644);
  return "created";
}

/** Remove ONLY our skill directory. Absent → no-op. Never touches sibling skills. */
export function removeSkill(home: string, name: string): SkillRemoveAction {
  const dir = skillDir(home, name);
  if (!existsSync(dir)) return "absent";
  rmSync(dir, { recursive: true, force: true });
  return "removed";
}

export type SkillHealth = "missing" | "current" | "stale";

/** Health of the installed skill versus the expected content. */
export function skillHealth(home: string, name: string, expected: string): SkillHealth {
  const file = skillFile(home, name);
  if (!existsSync(file)) return "missing";
  try {
    return readFileSync(file, "utf8") === expected ? "current" : "stale";
  } catch {
    return "stale";
  }
}
