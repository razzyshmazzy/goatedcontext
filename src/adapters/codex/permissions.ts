import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../utils/fs.ts";
import {
  CODEX_RULES_FILENAME,
  renderCodexRulesFile,
} from "../../core/agents/permissions.ts";

/**
 * Codex permission integration (0.3.5): install a DEDICATED, goatedcontext-owned
 * execpolicy rules file at `$CODEX_HOME/rules/goatedcontext.rules` that auto-approves
 * ONLY the safe `ctx` commands (argv-based `prefix_rule`s) and explicitly gates
 * `prefs approve/reject`. Because it is our own file, install/repair/uninstall are
 * trivially clean: we never touch `config.toml` (the writable-root merge lives there,
 * untouched) or the user's `default.rules`. A real file is written, never a symlink
 * (Codex silently ignores symlinked `.rules`).
 */

export type PermissionAction = "created" | "updated" | "unchanged" | "removed" | "absent" | "error";
export type RulesHealth = "missing" | "current" | "stale";

/** The goatedcontext-owned Codex rules file within a Codex home. */
export function codexRulesFile(home: string): string {
  return join(home, "rules", CODEX_RULES_FILENAME);
}

/** Install/refresh the ctx rules file. Byte-stable: an up-to-date file is left as-is. */
export function upsertCodexRules(home: string, platform: NodeJS.Platform = process.platform): PermissionAction {
  const file = codexRulesFile(home);
  const content = renderCodexRulesFile(platform);
  const existed = existsSync(file);
  if (existed) {
    try {
      if (readFileSync(file, "utf8") === content) return "unchanged";
    } catch {
      /* unreadable — fall through and rewrite */
    }
  }
  mkdirSync(join(home, "rules"), { recursive: true });
  writeFileAtomic(file, content, 0o644);
  return existed ? "updated" : "created";
}

/** Remove the goatedcontext-owned Codex rules file (ours only). */
export function removeCodexRules(home: string): PermissionAction {
  const file = codexRulesFile(home);
  if (!existsSync(file)) return "absent";
  rmSync(file, { force: true });
  return "removed";
}

/** Health of the installed Codex rules file versus the current rendered content. */
export function codexRulesHealth(home: string, platform: NodeJS.Platform = process.platform): RulesHealth {
  const file = codexRulesFile(home);
  if (!existsSync(file)) return "missing";
  try {
    return readFileSync(file, "utf8") === renderCodexRulesFile(platform) ? "current" : "stale";
  } catch {
    return "stale";
  }
}

/** Whether the ctx rules file is present and current. */
export function detectCodexRules(home: string, platform: NodeJS.Platform = process.platform): boolean {
  return codexRulesHealth(home, platform) === "current";
}
