import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs.ts";

/**
 * Generic, marker-delimited "managed block" upsert/remove for shared text files we
 * do NOT own outright (e.g. a project `AGENTS.md` that may contain the developer's
 * own instructions). A single block between `begin`/`end` markers is inserted,
 * refreshed in place, or removed, never disturbing anything outside the markers.
 *
 * This generalizes the pattern the Claude adapter uses for `CLAUDE.md`, so the
 * AGENTS.md projection (Codex + Cursor) can reuse it instead of reinventing it.
 * Writes are atomic (temp + rename); callers that need cross-process safety hold a
 * lock around the call.
 */

export type BlockAction = "created" | "updated" | "unchanged";

/** Remove every begin..end block from `text`, tolerating duplicates and a missing end. */
function stripBlocks(text: string, begin: string, end: string): { text: string; changed: boolean } {
  let out = text;
  let changed = false;
  for (;;) {
    const b = out.indexOf(begin);
    if (b === -1) break;
    const e = out.indexOf(end, b);
    out = e !== -1 ? out.slice(0, b) + out.slice(e + end.length) : out.slice(0, b);
    changed = true;
  }
  return { text: out, changed };
}

/**
 * Insert/refresh `block` (which MUST include its own begin/end markers) in `file`.
 * A well-formed existing block is refreshed in place (deduping stray blocks after
 * it); otherwise remnants are stripped and one fresh block is appended with a tidy
 * separator. Returns whether anything changed.
 */
export function upsertManagedBlock(
  file: string,
  begin: string,
  end: string,
  block: string,
): BlockAction {
  if (!existsSync(file)) {
    writeFileAtomic(file, block + "\n", 0o644);
    return "created";
  }
  const current = readFileSync(file, "utf8");
  const b = current.indexOf(begin);
  const e = current.indexOf(end);

  if (b !== -1 && e !== -1 && e > b) {
    const before = current.slice(0, b);
    const after = stripBlocks(current.slice(e + end.length), begin, end).text;
    const next = before + block + after;
    if (next === current) return "unchanged";
    writeFileAtomic(file, next, 0o644);
    return "updated";
  }

  const cleaned = stripBlocks(current, begin, end).text;
  const sep = cleaned.length === 0 ? "" : cleaned.endsWith("\n") ? "\n" : "\n\n";
  const next = cleaned + sep + block + "\n";
  if (next === current) return "unchanged";
  writeFileAtomic(file, next, 0o644);
  return "updated";
}

export type RemoveBlockAction = "removed" | "absent";

/** Remove the managed block(s), preserving unrelated content. Tidies blank lines. */
export function removeManagedBlock(file: string, begin: string, end: string): RemoveBlockAction {
  if (!existsSync(file)) return "absent";
  const current = readFileSync(file, "utf8");
  const { text, changed } = stripBlocks(current, begin, end);
  if (!changed) return "absent";
  const tidy = text.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  writeFileAtomic(file, tidy, 0o644);
  return "removed";
}

/** Whether a well-formed managed block currently exists in `file`. */
export function hasManagedBlock(file: string, begin: string, end: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const text = readFileSync(file, "utf8");
    const b = text.indexOf(begin);
    return b !== -1 && text.indexOf(end, b) !== -1;
  } catch {
    return false;
  }
}
