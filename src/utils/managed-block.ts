import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs.ts";
import { CtxError } from "./errors.ts";

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
 *
 * SAFETY (security wave): parsing FAILS CLOSED. A begin marker without a matching end,
 * or a begin nested inside another block, is ambiguous — we cannot tell where the
 * managed region stops without guessing, and guessing once silently deleted everything
 * after the marker to EOF. Instead we throw `ManagedBlockError` and leave the file's
 * bytes exactly as they were. A stray END marker with no preceding begin is harmless
 * user prose and is preserved. Only a structurally valid block is ever removed.
 */

export type BlockAction = "created" | "updated" | "unchanged";
export type RemoveBlockAction = "removed" | "absent";

/** A malformed/ambiguous managed-block structure was found; the file was left unchanged. */
export class ManagedBlockError extends CtxError {
  constructor(reason: string) {
    super(`managed block is malformed (${reason}); file was left unchanged.`);
    this.name = "ManagedBlockError";
  }
}

/** Half-open [start, end) spans of each well-formed begin..end block, in order. */
interface BlockSpan {
  start: number;
  end: number;
}

/**
 * Locate every well-formed managed block. Throws `ManagedBlockError` on ANY ambiguous
 * structure (a begin without a matching end, or a begin nested inside a block). A
 * leading/stray end marker with no begin is treated as ordinary text (not a block).
 */
function locateBlocks(text: string, begin: string, end: string): BlockSpan[] {
  const spans: BlockSpan[] = [];
  let from = 0;
  for (;;) {
    const b = text.indexOf(begin, from);
    if (b === -1) break;
    const e = text.indexOf(end, b + begin.length);
    if (e === -1) {
      throw new ManagedBlockError("begin marker without a matching end marker");
    }
    // A second begin before this block's end means nested/overlapping markers — we
    // cannot safely decide the boundaries, so refuse rather than truncate.
    const nested = text.indexOf(begin, b + begin.length);
    if (nested !== -1 && nested < e) {
      throw new ManagedBlockError("nested or overlapping begin markers");
    }
    spans.push({ start: b, end: e + end.length });
    from = e + end.length;
  }
  return spans;
}

/**
 * Insert/refresh `block` (which MUST include its own begin/end markers) in `file`.
 * A well-formed existing block is refreshed in place (deduping extra blocks); if none
 * exists, one fresh block is appended with a tidy separator. Throws `ManagedBlockError`
 * (leaving the file untouched) if the existing content has a malformed/ambiguous block.
 * Returns whether anything changed.
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
  const spans = locateBlocks(current, begin, end); // throws on malformed → no write

  let next: string;
  if (spans.length === 0) {
    // No managed block yet: append one, preserving every existing byte (incl. any
    // stray end marker, which is just user text).
    const sep = current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    next = current + sep + block + "\n";
  } else {
    // Replace the FIRST block in place; drop any duplicate blocks; keep all the user
    // text between/around them verbatim.
    const first = spans[0]!;
    let rebuilt = current.slice(0, first.start) + block;
    let cursor = first.end;
    for (let k = 1; k < spans.length; k++) {
      rebuilt += current.slice(cursor, spans[k]!.start);
      cursor = spans[k]!.end;
    }
    rebuilt += current.slice(cursor);
    next = rebuilt;
  }

  if (next === current) return "unchanged";
  writeFileAtomic(file, next, 0o644);
  return "updated";
}

/** Remove the managed block(s), preserving unrelated content. Tidies blank lines. */
export function removeManagedBlock(file: string, begin: string, end: string): RemoveBlockAction {
  if (!existsSync(file)) return "absent";
  const current = readFileSync(file, "utf8");
  const spans = locateBlocks(current, begin, end); // throws on malformed → no write
  if (spans.length === 0) return "absent";

  let out = "";
  let cursor = 0;
  for (const s of spans) {
    out += current.slice(cursor, s.start);
    cursor = s.end;
  }
  out += current.slice(cursor);
  const tidy = out.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  writeFileAtomic(file, tidy, 0o644);
  return "removed";
}

/**
 * Whether a well-formed managed block currently exists in `file`. Read-only and never
 * throws: a malformed structure (which upsert/remove would refuse) reports `false`.
 */
export function hasManagedBlock(file: string, begin: string, end: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const text = readFileSync(file, "utf8");
    return locateBlocks(text, begin, end).length > 0;
  } catch {
    return false;
  }
}
