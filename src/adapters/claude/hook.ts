import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../../utils/fs.ts";
import type { RetrievalResult } from "../../core/retrieval/retrieval.ts";
import { renderContextBlock, sanitizeInjectedText } from "../../core/render/context-block.ts";

// The runtime context block is now defined once, agent-neutrally, in core. Claude's
// adapter re-exports it under the historical names so the Claude hook output stays
// byte-for-byte identical and every existing import keeps working.
export { sanitizeInjectedText };

/**
 * Proactive-retrieval hook for Claude Code.
 *
 * We register a `UserPromptSubmit` hook in the user's Claude `settings.json`. When
 * a prompt is submitted, Claude runs the hook command; the command is just the ctx
 * CLI (`ctx hook claude-prompt`), which calls the SAME retrieval engine and prints
 * a compact context block to stdout. For `UserPromptSubmit`, stdout on exit 0 is
 * injected into Claude's context before it reasons about the request.
 *
 * No retrieval logic lives here or in settings — only the wiring.
 */
export const HOOK_COMMAND_DEFAULT = "ctx hook claude-prompt";
/** Substring that identifies OUR hook among possibly-many UserPromptSubmit hooks. */
export const HOOK_MARKER = "hook claude-prompt";
export const HOOK_TIMEOUT_SECONDS = 10;

interface CommandHook {
  type: "command";
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: CommandHook[];
}

function isOurHook(h: CommandHook): boolean {
  return h?.type === "command" && typeof h.command === "string" && h.command.includes(HOOK_MARKER);
}

function readSettings(file: string): { obj: Record<string, unknown> | null; existed: boolean } {
  if (!existsSync(file)) return { obj: {}, existed: false };
  try {
    return { obj: JSON.parse(readFileSync(file, "utf8")), existed: true };
  } catch {
    return { obj: null, existed: true }; // present but unparseable — never clobber
  }
}

export type HookAction = "created" | "updated" | "unchanged" | "removed" | "absent" | "error";

/** Install/refresh the UserPromptSubmit hook, preserving all other settings/hooks. */
export function upsertPromptHook(settingsFile: string, command: string): HookAction {
  const { obj } = readSettings(settingsFile);
  if (obj === null) return "error"; // invalid settings.json; leave it untouched

  const settings = obj as Record<string, unknown>;
  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  const groups = (hooks.UserPromptSubmit ??= []) as HookGroup[];
  if (!Array.isArray(hooks.UserPromptSubmit)) return "error";

  let found = false;
  let changed = false;
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks) {
      if (isOurHook(h)) {
        found = true;
        if (h.command !== command || h.timeout !== HOOK_TIMEOUT_SECONDS) {
          h.command = command;
          h.timeout = HOOK_TIMEOUT_SECONDS;
          changed = true;
        }
      }
    }
  }

  if (!found) {
    groups.push({ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] });
    changed = true;
  }

  if (!changed) return "unchanged";
  writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2) + "\n", 0o644);
  return found ? "updated" : "created";
}

/** Remove only OUR hook, keeping unrelated hooks and settings intact. */
export function removePromptHook(settingsFile: string): HookAction {
  const { obj } = readSettings(settingsFile);
  if (obj === null) return "error";
  const settings = obj as Record<string, unknown>;
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const groups = hooks?.UserPromptSubmit as HookGroup[] | undefined;
  if (!Array.isArray(groups)) return "absent";

  let changed = false;
  const kept: HookGroup[] = [];
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const remaining = group.hooks.filter((h) => !isOurHook(h));
    if (remaining.length !== group.hooks.length) changed = true;
    if (remaining.length > 0) kept.push({ ...group, hooks: remaining });
  }
  if (!changed) return "absent";

  if (kept.length > 0) (hooks as Record<string, unknown>).UserPromptSubmit = kept;
  else delete (hooks as Record<string, unknown>).UserPromptSubmit;
  writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2) + "\n", 0o644);
  return "removed";
}

/** Whether our prompt hook is currently configured. */
export function detectPromptHook(settingsFile: string): boolean {
  const { obj } = readSettings(settingsFile);
  if (!obj) return false;
  const groups = (obj as { hooks?: { UserPromptSubmit?: HookGroup[] } })?.hooks?.UserPromptSubmit;
  if (!Array.isArray(groups)) return false;
  return groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isOurHook));
}

/** The exact command string configured for our prompt hook, or null if absent. */
export function getPromptHookCommand(settingsFile: string): string | null {
  const { obj } = readSettings(settingsFile);
  if (!obj) return null;
  const groups = (obj as { hooks?: { UserPromptSubmit?: HookGroup[] } })?.hooks?.UserPromptSubmit;
  if (!Array.isArray(groups)) return null;
  for (const g of groups) {
    if (!Array.isArray(g?.hooks)) continue;
    for (const h of g.hooks) if (isOurHook(h)) return h.command;
  }
  return null;
}

/**
 * Format the compact context block injected at Claude prompt time. A thin wrapper
 * over the agent-neutral `renderContextBlock` (core), preserved under its historical
 * name so Claude output and every caller/test are unchanged. Returns null when there
 * is nothing relevant. Never includes confidence internals, evidence, or secrets.
 */
export function formatHookContext(result: RetrievalResult): string | null {
  return renderContextBlock(result);
}
