import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../../utils/fs.ts";
import { allClaudeOwnedRules, claudePermissionRules } from "../../core/agents/permissions.ts";

/**
 * Claude Code permission integration (0.3.5): install NARROW `permissions.allow`
 * rules (and `deny` gates) into `~/.claude/settings.json` so the agent can run the
 * safe `ctx` memory/context commands without a per-call approval prompt — WITHOUT
 * `--dangerously-skip-permissions` and WITHOUT any `Bash(*)` blanket.
 *
 * Owns ONLY the exact ctx rule strings it generates; every other permission, hook and
 * setting is preserved byte-for-byte. Shares the settings.json file with the prompt
 * hook, so edits are additive + atomic. A present-but-unparseable settings.json is
 * never clobbered (returns `error`, matching the hook's fail-safe behavior).
 */

export type PermissionAction = "created" | "updated" | "unchanged" | "removed" | "absent" | "error";

function readSettings(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return {};
  try {
    const obj = JSON.parse(readFileSync(file, "utf8"));
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null; // present but unparseable — never clobber
  }
}

function asStringArray(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return null; // present but wrong shape — refuse to touch
}

/** Install/refresh the narrow ctx permission rules, preserving all other settings. */
export function upsertClaudePermissions(
  settingsFile: string,
  platform: NodeJS.Platform = process.platform,
): PermissionAction {
  const settings = readSettings(settingsFile);
  if (settings === null) return "error";

  const hadPermissions = settings.permissions !== undefined;
  const permissions = (settings.permissions ??= {}) as Record<string, unknown>;
  if (typeof permissions !== "object" || Array.isArray(permissions)) return "error";

  const allow = asStringArray(permissions.allow);
  const deny = asStringArray(permissions.deny);
  if (allow === null || deny === null) return "error";

  const want = claudePermissionRules(platform);
  let changed = false;
  for (const rule of want.allow) {
    if (!allow.includes(rule)) {
      allow.push(rule);
      changed = true;
    }
  }
  for (const rule of want.deny) {
    if (!deny.includes(rule)) {
      deny.push(rule);
      changed = true;
    }
  }
  if (!changed) return "unchanged";

  permissions.allow = allow;
  permissions.deny = deny;
  writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2) + "\n", 0o644);
  return hadPermissions ? "updated" : "created";
}

/** Remove ONLY the ctx-owned permission rules (any platform's), preserving the rest. */
export function removeClaudePermissions(settingsFile: string): PermissionAction {
  const settings = readSettings(settingsFile);
  if (settings === null) return "error";
  const permissions = settings.permissions as Record<string, unknown> | undefined;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return "absent";

  const owned = allClaudeOwnedRules();
  let changed = false;

  for (const [key, set] of [["allow", owned.allow], ["deny", owned.deny]] as const) {
    const arr = permissions[key];
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((x) => !(typeof x === "string" && set.has(x)));
    if (kept.length !== arr.length) {
      changed = true;
      if (kept.length === 0) delete permissions[key];
      else permissions[key] = kept;
    }
  }
  if (!changed) return "absent";
  // Tidy: drop an emptied `permissions` object we no longer contribute to.
  if (Object.keys(permissions).length === 0) delete settings.permissions;
  writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2) + "\n", 0o644);
  return "removed";
}

/** Whether the current platform's full ctx rule set is present and healthy. */
export function detectClaudePermissions(
  settingsFile: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const settings = readSettings(settingsFile);
  if (!settings) return false;
  const permissions = settings.permissions as Record<string, unknown> | undefined;
  if (!permissions) return false;
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : [];
  const deny = Array.isArray(permissions.deny) ? (permissions.deny as string[]) : [];
  const want = claudePermissionRules(platform);
  return want.allow.every((r) => allow.includes(r)) && want.deny.every((r) => deny.includes(r));
}
