import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../utils/fs.ts";

/**
 * Codex CLI runtime adapter wiring.
 *
 * Per current Codex docs, Codex supports lifecycle hooks (incl. `UserPromptSubmit`)
 * configured in `~/.codex/hooks.json` (or an inline `[hooks]` table in
 * `config.toml`), and a `UserPromptSubmit` handler may inject text — either as plain
 * stdout or as `{"hookSpecificOutput":{"additionalContext":"…"}}`. We use the
 * plain-stdout form (lowest-risk, same as Claude) and register the command in
 * `hooks.json`.
 *
 * CAVEAT: Codex hooks are a new, fast-moving surface and the docs state the schema
 * "mirrors Claude Code" without pinning the exact `hooks.json` shape. We therefore
 * use the Claude-shaped structure, keep the write additive + idempotent + fully
 * reversible, and recommend verifying against the installed Codex version. Only our
 * own entry is ever touched; unrelated hooks/config are preserved.
 */

export const CODEX_HOOK_COMMAND_DEFAULT = "ctx hook codex-prompt";
/** Substring identifying OUR hook among possibly-many UserPromptSubmit hooks. */
export const CODEX_HOOK_MARKER = "hook codex-prompt";

/** Resolve the Codex config dir: `$CODEX_HOME` or `~/.codex`. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const h = env.CODEX_HOME;
  return h && h.trim().length > 0 ? h : join(homedir(), ".codex");
}

export function codexHooksFile(home: string): string {
  return join(home, "hooks.json");
}

interface CommandHook {
  type: "command";
  command: string;
}
interface HookGroup {
  hooks: CommandHook[];
}

export type HookAction = "created" | "updated" | "unchanged" | "removed" | "absent" | "error";

function isOurHook(h: CommandHook): boolean {
  return h?.type === "command" && typeof h.command === "string" && h.command.includes(CODEX_HOOK_MARKER);
}

function read(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // present but unparseable — never clobber
  }
}

/** Install/refresh the Codex UserPromptSubmit hook, preserving all other hooks. */
export function upsertCodexHook(hooksFile: string, command: string): HookAction {
  const obj = read(hooksFile);
  if (obj === null) return "error";
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
        if (h.command !== command) {
          h.command = command;
          changed = true;
        }
      }
    }
  }
  if (!found) {
    groups.push({ hooks: [{ type: "command", command }] });
    changed = true;
  }
  if (!changed) return "unchanged";
  writeFileAtomic(hooksFile, JSON.stringify(settings, null, 2) + "\n", 0o644);
  return found ? "updated" : "created";
}

/** Remove only OUR Codex hook, keeping unrelated hooks intact. */
export function removeCodexHook(hooksFile: string): HookAction {
  const obj = read(hooksFile);
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
  writeFileAtomic(hooksFile, JSON.stringify(settings, null, 2) + "\n", 0o644);
  return "removed";
}

/** Whether our Codex hook is currently configured. */
export function detectCodexHook(hooksFile: string): boolean {
  const obj = read(hooksFile);
  if (!obj) return false;
  const groups = (obj as { hooks?: { UserPromptSubmit?: HookGroup[] } })?.hooks?.UserPromptSubmit;
  if (!Array.isArray(groups)) return false;
  return groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isOurHook));
}
