import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../utils/fs.ts";

/**
 * Cursor `sessionStart` hook wiring in `~/.cursor/hooks.json` (0.4.0).
 *
 * Verified against current Cursor docs (2026). Schema:
 *   { "version": 1, "hooks": { "sessionStart": [ { "command": "...", "type": "command" } ] } }
 * A `sessionStart` hook may return `{"additional_context": "..."}` on stdout — note
 * Cursor requires JSON here, unlike Claude/Codex plain stdout. We register ONLY a
 * `sessionStart` hook: `beforeSubmitPrompt` is block-only (it cannot inject context),
 * so per-task retrieval is delegated to the ctx MCP server instead — we never fake an
 * unsupported per-prompt injection.
 *
 * Ownership is surgical: only the entry whose command contains our marker is ever
 * added/updated/removed; unrelated hooks (and the file's other keys) are preserved
 * byte-for-byte via a parsed round-trip. A present-but-unparseable file is NEVER
 * clobbered (returns "error").
 */

/** Substring identifying OUR hook among possibly-many sessionStart hooks. */
export const CURSOR_HOOK_MARKER = "hook cursor-session";

export function cursorHooksFile(home: string): string {
  return join(home, "hooks.json");
}

interface CursorHookEntry {
  command?: string;
  type?: string;
  [k: string]: unknown;
}

export type CursorHookAction = "created" | "updated" | "unchanged" | "removed" | "absent" | "error";

function isOurs(h: CursorHookEntry): boolean {
  return typeof h?.command === "string" && h.command.includes(CURSOR_HOOK_MARKER);
}

function read(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null; // a non-object top level is malformed for our purposes — never clobber
  } catch {
    return null;
  }
}

/** Install/refresh OUR Cursor sessionStart hook, preserving everything else. */
export function upsertCursorHook(hooksFile: string, command: string): CursorHookAction {
  const settings = read(hooksFile);
  if (settings === null) return "error";
  if (settings.version === undefined) settings.version = 1; // Cursor's documented schema version
  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return "error";
  const list = (hooks.sessionStart ??= []) as CursorHookEntry[];
  if (!Array.isArray(list)) return "error";

  let found = false;
  let changed = false;
  for (const h of list) {
    if (isOurs(h)) {
      found = true;
      if (h.command !== command) {
        h.command = command;
        changed = true;
      }
      if (h.type !== "command") {
        h.type = "command";
        changed = true;
      }
    }
  }
  if (!found) {
    list.push({ command, type: "command" });
    changed = true;
  }
  if (!changed) return "unchanged";
  writeFileAtomic(hooksFile, JSON.stringify(settings, null, 2) + "\n", 0o644);
  return found ? "updated" : "created";
}

/** Remove ONLY our Cursor hook, keeping unrelated hooks intact. */
export function removeCursorHook(hooksFile: string): CursorHookAction {
  const settings = read(hooksFile);
  if (settings === null) return "error";
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const list = hooks?.sessionStart as CursorHookEntry[] | undefined;
  if (!Array.isArray(list)) return "absent";
  const kept = list.filter((h) => !isOurs(h));
  if (kept.length === list.length) return "absent";
  if (kept.length > 0) (hooks as Record<string, unknown>).sessionStart = kept;
  else delete (hooks as Record<string, unknown>).sessionStart;
  writeFileAtomic(hooksFile, JSON.stringify(settings, null, 2) + "\n", 0o644);
  return "removed";
}

/** Whether our Cursor sessionStart hook is currently configured. */
export function detectCursorHook(hooksFile: string): boolean {
  const settings = read(hooksFile);
  if (!settings) return false;
  const list = (settings as { hooks?: { sessionStart?: CursorHookEntry[] } })?.hooks?.sessionStart;
  return Array.isArray(list) && list.some(isOurs);
}
