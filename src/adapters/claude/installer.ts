import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
import {
  upsertClaudePermissions,
  removeClaudePermissions,
  type PermissionAction,
} from "./permissions.ts";
import {
  upsertManagedBlock,
  removeManagedBlock,
  hasManagedBlock,
} from "../../utils/managed-block.ts";

export interface ClaudeInstallOptions {
  /** Root of the Claude user config dir. Defaults to ~/.claude (override for tests). */
  claudeHome?: string;
  /** The shell command Claude runs for the prompt hook (default `ctx hook claude-prompt`). */
  hookCommand?: string;
  /** Remove the proactive-retrieval hook instead of installing it (keeps skills/prefs). */
  disableHook?: boolean;
  /** Override the host platform (for deterministic tests). Affects ctx/ctx.cmd rules. */
  platform?: NodeJS.Platform;
}

export interface ClaudeInstallResult {
  skillsDir: string;
  installedSkills: string[];
  instructionsFile: string;
  instructionsAction: "created" | "updated" | "unchanged";
  settingsFile: string;
  hookAction: HookAction;
  /** Outcome of installing the narrow ctx command permission rules (seamless writes). */
  permissionAction: PermissionAction;
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
    // Narrow ctx command permissions make memory writes seamless (no per-call prompt).
    // Installed regardless of the read hook — writes flow through the memory skill.
    const permissionAction = upsertClaudePermissions(settingsFile, opts.platform ?? process.platform);

    return {
      skillsDir: skillsRoot,
      installedSkills,
      instructionsFile,
      instructionsAction: action,
      settingsFile,
      hookAction,
      permissionAction,
    };
  });
}

export interface ClaudeRepairResult {
  skillsDir: string;
  /** Per-skill outcome: already correct, or rewritten because missing/corrupt. */
  skills: { dir: string; action: "ok" | "restored" }[];
  instructionsFile: string;
  instructionsAction: "ok" | "restored" | "repaired";
  settingsFile: string;
  hookAction: HookAction;
  permissionAction: PermissionAction;
}

/**
 * Repair a Claude install: rewrite any missing or corrupted ctx-owned files
 * (skills, the instruction block) and restore the prompt hook, while preserving
 * every unrelated Claude setting, hook and instruction. Idempotent — repairing a
 * healthy install reports everything "ok"/"unchanged" and changes nothing.
 */
export function repairClaude(opts: ClaudeInstallOptions = {}): ClaudeRepairResult {
  const claudeHome = opts.claudeHome ?? join(homedir(), ".claude");
  mkdirSync(claudeHome, { recursive: true });
  const lockFile = join(claudeHome, ".ctx-install.lock");

  return withFileLock(lockFile, () => {
    const skillsRoot = join(claudeHome, "skills");
    mkdirSync(skillsRoot, { recursive: true });

    const skills: { dir: string; action: "ok" | "restored" }[] = [];
    for (const skill of CLAUDE_SKILLS) {
      const dir = join(skillsRoot, skill.dir);
      const file = join(dir, "SKILL.md");
      let healthy = false;
      try {
        healthy = existsSync(file) && readFileSync(file, "utf8") === skill.content;
      } catch {
        healthy = false;
      }
      if (!healthy) {
        mkdirSync(dir, { recursive: true });
        writeFileAtomic(file, skill.content, 0o644);
      }
      skills.push({ dir: skill.dir, action: healthy ? "ok" : "restored" });
    }

    // Determine whether a well-formed block already existed, to distinguish a
    // clean restore from a repair of damaged content.
    const instructionsFile = join(claudeHome, "CLAUDE.md");
    const hadWellFormedBlock = instructionBlockState(instructionsFile) === "well-formed";
    const upsert = upsertInstructionBlock(instructionsFile);
    const instructionsAction: ClaudeRepairResult["instructionsAction"] =
      upsert === "unchanged" ? "ok" : hadWellFormedBlock ? "repaired" : "restored";

    const settingsFile = join(claudeHome, "settings.json");
    const hookAction = opts.disableHook
      ? removePromptHook(settingsFile)
      : upsertPromptHook(settingsFile, opts.hookCommand ?? HOOK_COMMAND_DEFAULT);
    const permissionAction = upsertClaudePermissions(settingsFile, opts.platform ?? process.platform);

    return { skillsDir: skillsRoot, skills, instructionsFile, instructionsAction, settingsFile, hookAction, permissionAction };
  });
}

export interface ClaudeUninstallResult {
  skillsDir: string;
  /** ctx skill dirs that existed and were removed. */
  removedSkills: string[];
  instructionsFile: string;
  instructionsAction: "removed" | "absent";
  settingsFile: string;
  hookAction: HookAction;
  permissionAction: PermissionAction;
}

/**
 * Remove ONLY the goatedcontext-owned Claude integration: the ctx skills, the ctx
 * instruction block, and the ctx prompt hook. Unrelated skills, hooks, settings and
 * user instructions are preserved. Never touches ~/.ctx, so preferences and
 * environments are untouched. Idempotent.
 */
export function uninstallClaude(opts: ClaudeInstallOptions = {}): ClaudeUninstallResult {
  const claudeHome = opts.claudeHome ?? join(homedir(), ".claude");
  const lockFile = join(claudeHome, ".ctx-install.lock");
  const skillsRoot = join(claudeHome, "skills");
  const settingsFile = join(claudeHome, "settings.json");
  const instructionsFile = join(claudeHome, "CLAUDE.md");

  if (!existsSync(claudeHome)) {
    return {
      skillsDir: skillsRoot,
      removedSkills: [],
      instructionsFile,
      instructionsAction: "absent",
      settingsFile,
      hookAction: "absent",
      permissionAction: "absent",
    };
  }

  mkdirSync(claudeHome, { recursive: true });
  return withFileLock(lockFile, () => {
    const removedSkills: string[] = [];
    for (const skill of CLAUDE_SKILLS) {
      const dir = join(skillsRoot, skill.dir);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        removedSkills.push(skill.dir);
      }
    }

    const instructionsAction = removeInstructionBlock(instructionsFile);
    const hookAction = removePromptHook(settingsFile);
    const permissionAction = removeClaudePermissions(settingsFile);

    return { skillsDir: skillsRoot, removedSkills, instructionsFile, instructionsAction, settingsFile, hookAction, permissionAction };
  });
}

/**
 * Classify the ctx block for repair reporting. A begin marker with no matching end is
 * "damaged" — the safe parser refuses to rewrite such a file (it would truncate user
 * content), so repair fails closed rather than guessing. Read-only; never throws.
 */
function instructionBlockState(file: string): "none" | "well-formed" | "damaged" {
  if (!existsSync(file)) return "none";
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "none";
  }
  if (!text.includes(CTX_INSTRUCTION_BEGIN)) return "none";
  // hasManagedBlock is true only for a structurally valid block; a malformed one → false.
  return hasManagedBlock(file, CTX_INSTRUCTION_BEGIN, CTX_INSTRUCTION_END)
    ? "well-formed"
    : "damaged";
}

/**
 * Adds/refreshes the ctx block in a global instructions file without disturbing
 * anything else, via the shared fail-closed managed-block parser. A well-formed block
 * is refreshed in place (duplicates deduped); if none exists a single fresh block is
 * appended. A malformed/ambiguous block (begin without matching end) makes this THROW
 * `ManagedBlockError` and leaves CLAUDE.md byte-for-byte unchanged — never truncated.
 */
export function upsertInstructionBlock(file: string): "created" | "updated" | "unchanged" {
  return upsertManagedBlock(file, CTX_INSTRUCTION_BEGIN, CTX_INSTRUCTION_END, CTX_INSTRUCTION_BLOCK);
}

/**
 * Remove the ctx instruction block, preserving unrelated user instructions. Returns
 * "removed" when a block was present, "absent" otherwise. Throws (file untouched) if
 * the block is malformed, so removal can never truncate user content to EOF.
 */
export function removeInstructionBlock(file: string): "removed" | "absent" {
  return removeManagedBlock(file, CTX_INSTRUCTION_BEGIN, CTX_INSTRUCTION_END);
}
