#!/usr/bin/env bun
/**
 * Regenerates the committed `skills/**\/SKILL.md` files from the canonical skill
 * definitions in the Claude adapter, keeping a single source of truth.
 *
 *   bun run scripts/gen-skills.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_SKILLS } from "../src/adapters/claude/skills.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(root, "skills");

for (const skill of CLAUDE_SKILLS) {
  const dir = join(skillsRoot, skill.dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skill.content, "utf8");
  console.log(`wrote skills/${skill.dir}/SKILL.md`);
}
