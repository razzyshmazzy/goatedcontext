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

/** Classify the ctx block in an instructions file for reporting/repair decisions. */
function instructionBlockState(file: string): "none" | "well-formed" | "damaged" {
  if (!existsSync(file)) return "none";
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "none";
  }
  const begin = text.indexOf(CTX_INSTRUCTION_BEGIN);
  if (begin === -1) return "none";
  const end = text.indexOf(CTX_INSTRUCTION_END, begin);
  return end !== -1 ? "well-formed" : "damaged";
}

/**
 * Remove every ctx instruction block from `text`, preserving everything else.
 * Handles duplicated blocks and a damaged block whose end marker is missing
 * (treated as running to end-of-file). Returns the cleaned text and whether any
 * block was found.
 */
function removeAllCtxBlocks(text: string): { text: string; changed: boolean } {
  let out = text;
  let changed = false;
  while (true) {
    const b = out.indexOf(CTX_INSTRUCTION_BEGIN);
    if (b === -1) break;
    const e = out.indexOf(CTX_INSTRUCTION_END, b);
    out =
      e !== -1
        ? out.slice(0, b) + out.slice(e + CTX_INSTRUCTION_END.length)
        : out.slice(0, b); // damaged: no end marker → strip to EOF
    changed = true;
  }
  return { text: out, changed };
}

/**
 * Adds/refreshes the ctx block in a global instructions file without disturbing
 * anything else. Robust against a damaged (end-marker-less) or duplicated block:
 * a well-formed block is refreshed in place, otherwise the file is cleaned and a
 * single fresh block is appended. Atomic write; racing callers hold the install lock.
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
    // Well-formed block: refresh it in place, deduping any stray blocks after it.
    const before = current.slice(0, begin);
    const after = removeAllCtxBlocks(current.slice(end + CTX_INSTRUCTION_END.length)).text;
    const next = before + CTX_INSTRUCTION_BLOCK + after;
    if (next === current) return "unchanged";
    writeFileAtomic(file, next, 0o644);
    return "updated";
  }

  // No block, or a damaged begin-without-end: strip any remnants and append fresh.
  const cleaned = removeAllCtxBlocks(current).text;
  const separator = cleaned.length === 0 ? "" : cleaned.endsWith("\n") ? "\n" : "\n\n";
  const next = cleaned + separator + CTX_INSTRUCTION_BLOCK + "\n";
  if (next === current) return "unchanged";
  writeFileAtomic(file, next, 0o644);
  return "updated";
}

/**
 * Remove the ctx instruction block, preserving unrelated user instructions.
 * Returns "removed" when a block was present, "absent" otherwise.
 */
export function removeInstructionBlock(file: string): "removed" | "absent" {
  if (!existsSync(file)) return "absent";
  const current = readFileSync(file, "utf8");
  const { text, changed } = removeAllCtxBlocks(current);
  if (!changed) return "absent";
  // Tidy blank lines left behind by the removal.
  const tidy = text.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  writeFileAtomic(file, tidy, 0o644);
  return "removed";
}
