import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_SKILLS,
  CTX_INSTRUCTION_BLOCK,
  CTX_INSTRUCTION_BEGIN,
  CTX_INSTRUCTION_END,
} from "./skills.ts";

export interface ClaudeInstallOptions {
  /** Root of the Claude user config dir. Defaults to ~/.claude (override for tests). */
  claudeHome?: string;
}

export interface ClaudeInstallResult {
  skillsDir: string;
  installedSkills: string[];
  instructionsFile: string;
  instructionsAction: "created" | "updated" | "unchanged";
}

/**
 * Installs the ctx Claude Code adapter:
 *  1. writes the context / context-learn / context-env skills into the user's
 *     global Claude skills directory, and
 *  2. inserts (or refreshes) a single, marker-delimited block into the user's
 *     global Claude instructions.
 *
 * Idempotent: running it twice never duplicates skills or the instruction block,
 * and it never touches unrelated instruction content.
 */
export function installClaude(opts: ClaudeInstallOptions = {}): ClaudeInstallResult {
  const claudeHome = opts.claudeHome ?? join(homedir(), ".claude");
  const skillsRoot = join(claudeHome, "skills");
  mkdirSync(skillsRoot, { recursive: true });

  const installedSkills: string[] = [];
  for (const skill of CLAUDE_SKILLS) {
    const dir = join(skillsRoot, skill.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skill.content, "utf8");
    installedSkills.push(skill.dir);
  }

  const instructionsFile = join(claudeHome, "CLAUDE.md");
  const action = upsertInstructionBlock(instructionsFile);

  return {
    skillsDir: skillsRoot,
    installedSkills,
    instructionsFile,
    instructionsAction: action,
  };
}

/**
 * Adds the ctx block to a global instructions file without disturbing anything
 * else. If the marker block already exists it is replaced in place; otherwise
 * the block is appended.
 */
export function upsertInstructionBlock(file: string): "created" | "updated" | "unchanged" {
  if (!existsSync(file)) {
    writeFileSync(file, CTX_INSTRUCTION_BLOCK + "\n", "utf8");
    return "created";
  }

  const current = readFileSync(file, "utf8");
  const begin = current.indexOf(CTX_INSTRUCTION_BEGIN);
  const end = current.indexOf(CTX_INSTRUCTION_END);

  if (begin !== -1 && end !== -1 && end > begin) {
    const before = current.slice(0, begin);
    const after = current.slice(end + CTX_INSTRUCTION_END.length);
    const next = before + CTX_INSTRUCTION_BLOCK + after;
    if (next === current) return "unchanged";
    writeFileSync(file, next, "utf8");
    return "updated";
  }

  const separator = current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(file, current + separator + CTX_INSTRUCTION_BLOCK + "\n", "utf8");
  return "updated";
}
