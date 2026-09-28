import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic, withFileLock } from "../../utils/fs.ts";
import {
  CLAUDE_SKILLS,
  CTX_INSTRUCTION_BLOCK,
  CTX_INSTRUCTION_BEGIN,
  CTX_INSTRUCTION_END,
} from "./skills.ts";
import {
  HOOK_COMMAND_DEFAULT,
  upsertPromptHook,
  removePromptHook,
  type HookAction,
} from "./hook.ts";

export interface ClaudeInstallOptions {
  /** Root of the Claude user config dir. Defaults to ~/.claude (override for tests). */
  claudeHome?: string;
  /** The shell command Claude runs for the prompt hook (default `ctx hook claude-prompt`). */
  hookCommand?: string;
  /** Remove the proactive-retrieval hook instead of installing it (keeps skills/prefs). */
  disableHook?: boolean;
}

export interface ClaudeInstallResult {
  skillsDir: string;
  installedSkills: string[];
  instructionsFile: string;
  instructionsAction: "created" | "updated" | "unchanged";
  settingsFile: string;
  hookAction: HookAction;
}

/**
 * Installs the ctx Claude Code adapter:
 *  1. writes the context / context-learn / context-env skills, and
 *  2. inserts (or refreshes) a single, marker-delimited block into the user's
 *     global Claude instructions.
 *
 * Concurrency-safe and idempotent: the whole install runs under an O_EXCL lock in
 * the Claude home, every file is written atomically (temp + rename), and the
 * instruction block is upserted between markers. Two simultaneous installs cannot
 * duplicate the block, produce a partial skill file, or truncate CLAUDE.md.
 */
export function installClaude(opts: ClaudeInstallOptions = {}): ClaudeInstallResult {
  const claudeHome = opts.claudeHome ?? join(homedir(), ".claude");
  mkdirSync(claudeHome, { recursive: true });
  const lockFile = join(claudeHome, ".ctx-install.lock");

  return withFileLock(lockFile, () => {
    const skillsRoot = join(claudeHome, "skills");
    mkdirSync(skillsRoot, { recursive: true });

    const installedSkills: string[] = [];
    for (const skill of CLAUDE_SKILLS) {
      const dir = join(skillsRoot, skill.dir);
      mkdirSync(dir, { recursive: true });
      writeFileAtomic(join(dir, "SKILL.md"), skill.content, 0o644);
      installedSkills.push(skill.dir);
    }

    const instructionsFile = join(claudeHome, "CLAUDE.md");
    const action = upsertInstructionBlock(instructionsFile);

    // Proactive-retrieval hook lives in settings.json (merged, never clobbering
    // unrelated hooks/settings; atomic write).
    const settingsFile = join(claudeHome, "settings.json");
    const hookAction = opts.disableHook
      ? removePromptHook(settingsFile)
      : upsertPromptHook(settingsFile, opts.hookCommand ?? HOOK_COMMAND_DEFAULT);

    return {
      skillsDir: skillsRoot,
      installedSkills,
      instructionsFile,
      instructionsAction: action,
      settingsFile,
      hookAction,
    };
  });
}

/**
 * Adds/refreshes the ctx block in a global instructions file without disturbing
 * anything else. Atomic write; callers that may race should hold the install lock.
 */
export function upsertInstructionBlock(file: string): "created" | "updated" | "unchanged" {
  if (!existsSync(file)) {
    writeFileAtomic(file, CTX_INSTRUCTION_BLOCK + "\n", 0o644);
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
    writeFileAtomic(file, next, 0o644);
    return "updated";
  }

  const separator = current.endsWith("\n") ? "\n" : "\n\n";
  writeFileAtomic(file, current + separator + CTX_INSTRUCTION_BLOCK + "\n", 0o644);
  return "updated";
}
