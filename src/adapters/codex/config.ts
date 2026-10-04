import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../utils/fs.ts";

/**
 * Safe, dependency-free merge of a single writable root into Codex's TOML config.
 *
 * Codex's workspace-write sandbox only grants write access to the working directory
 * plus any paths listed under `[sandbox_workspace_write].writable_roots` (an array of
 * strings) in `$CODEX_HOME/config.toml`. Because the ctx database lives OUTSIDE the
 * repo (at `~/.ctx` by default), a sandboxed Codex child cannot persist preferences —
 * the exact "unable to open database file" failure this release fixes. We add the
 * effective CTX_HOME as a writable root so `ctx remember` works under normal
 * sandboxing (no Full Access, no policy changes).
 *
 * WHY A HAND-ROLLED EDITOR (not a TOML dependency): the published package ships with
 * exactly two runtime deps (commander, zod) and no native code — a constraint the
 * distribution tests enforce. A parse-then-stringify round-trip would also discard
 * the user's comments and formatting. Instead we do a focused, char-level scan that
 * locates ONLY the one array we touch and preserves every other byte verbatim. The
 * scanner is conservative: on anything it cannot confidently interpret (unterminated
 * string, a `writable_roots` that isn't an array, an unparseable line) it REFUSES and
 * returns `error`, leaving the file untouched — never a fragile regex over arbitrary
 * TOML, never a destructive rewrite.
 */

export const CODEX_SANDBOX_TABLE = "sandbox_workspace_write";
export const CODEX_WRITABLE_ROOTS_KEY = "writable_roots";

export type WritableRootAction = "created" | "added" | "present" | "error";

export interface WritableRootResult {
  action: WritableRootAction;
  /** Human-readable reason for `error`, or a short note otherwise. */
  detail?: string;
}

/** The Codex config file within a Codex home (`$CODEX_HOME/config.toml`). */
export function codexConfigFile(home: string): string {
  return join(home, "config.toml");
}

// ── platform-aware path normalization ────────────────────────────────────────

/**
 * The textual value to store in the TOML array. On Windows we emit forward slashes
 * inside a basic string: a native `C:\Users\…` path would make `\U`/`\A` look like
 * (invalid) TOML escape sequences, whereas `C:/Users/…` is a valid basic string that
 * Windows path APIs accept identically. POSIX paths are stored verbatim.
 */
export function tomlRootValue(ctxHome: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? ctxHome.replace(/\\/g, "/") : ctxHome;
}

/**
 * Canonical form for comparing two roots for equality. Windows paths are compared
 * case-insensitively and with slashes unified (so `C:\Users\Admin\.ctx`,
 * `C:/Users/Admin/.ctx`, and `c:\users\admin\.ctx` all match). POSIX paths keep their
 * case and separators — we must NOT apply Windows case-folding on POSIX.
 */
export function canonicalRoot(p: string, platform: NodeJS.Platform = process.platform): string {
  let s = p.trim();
  if (platform === "win32") {
    s = s.replace(/\\/g, "/").toLowerCase();
  }
  // Collapse duplicate separators and strip a single trailing slash (but keep "/").
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

// ── a focused TOML scanner (only what we need to find/edit one array) ─────────

interface ScanError {
  kind: "error";
  reason: string;
}
interface NoTable {
  kind: "none";
}
interface TableNoKey {
  kind: "table-no-key";
  /** Char index immediately after the table header line (where to insert the key). */
  insertAt: number;
}
interface FoundKey {
  kind: "key";
  /** Index of the opening `[` of the array value. */
  arrayStart: number;
  /** Index of the matching closing `]` of the array value. */
  arrayEnd: number;
  /** Parsed string elements (non-string elements are ignored for membership). */
  elements: string[];
  /** Whether the original array text spans multiple lines. */
  multiline: boolean;
}
type Located = ScanError | NoTable | TableNoKey | FoundKey;

/** Skip a TOML string starting at `i` (a quote char). Returns index AFTER the close, or -1. */
function skipString(text: string, i: number): number {
  const q = text[i]!;
  // Multi-line variants: """ or '''
  if (text.startsWith(q.repeat(3), i)) {
    const close = text.indexOf(q.repeat(3), i + 3);
    return close === -1 ? -1 : close + 3;
  }
  // Single-line: closes on an unescaped matching quote; a raw newline is illegal.
  let j = i + 1;
  while (j < text.length) {
    const c = text[j]!;
    if (c === "\n") return -1;
    if (q === '"' && c === "\\") {
      j += 2;
      continue;
    }
    if (c === q) return j + 1;
    j++;
  }
  return -1;
}

/**
 * Skip a balanced bracketed value (`[...]` array or `{...}` inline table) starting at
 * the opening bracket `i`, respecting nested brackets, strings and comments. Returns
 * the index of the matching close bracket, or -1 if unbalanced/unterminated.
 */
function skipBalanced(text: string, i: number): number {
  const open = text[i]!;
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const c = text[j]!;
    if (c === '"' || c === "'") {
      const next = skipString(text, j);
      if (next === -1) return -1;
      j = next;
      continue;
    }
    if (c === "#") {
      const nl = text.indexOf("\n", j);
      if (nl === -1) return -1; // comment with no newline and no close
      j = nl;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  return -1;
}

/** From a value-start index, return the index just past the value (scalars stop at a delimiter). */
function skipValue(text: string, i: number): number {
  let j = i;
  while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
  const c = text[j];
  if (c === '"' || c === "'") {
    const n = skipString(text, j);
    return n;
  }
  if (c === "[" || c === "{") {
    const n = skipBalanced(text, j);
    return n === -1 ? -1 : n + 1;
  }
  // Scalar (number/bool/date/etc): read to a newline, comment, or structural delimiter.
  while (j < text.length) {
    const ch = text[j]!;
    if (ch === "\n" || ch === "#" || ch === "," || ch === "]" || ch === "}") break;
    j++;
  }
  return j;
}

/** Parse the string elements inside an array whose `[`/`]` are at arrayStart/arrayEnd. */
function parseArrayStrings(text: string, arrayStart: number, arrayEnd: number): string[] {
  const out: string[] = [];
  let j = arrayStart + 1;
  while (j < arrayEnd) {
    const c = text[j]!;
    if (c === '"' || c === "'") {
      const end = skipString(text, j);
      if (end === -1) break;
      out.push(decodeTomlString(text.slice(j, end)));
      j = end;
      continue;
    }
    if (c === "#") {
      const nl = text.indexOf("\n", j);
      j = nl === -1 ? arrayEnd : nl;
      continue;
    }
    if (c === "[" || c === "{") {
      // Nested value — not a path string we care about; skip it wholesale.
      const end = skipBalanced(text, j);
      j = end === -1 ? arrayEnd : end + 1;
      continue;
    }
    j++;
  }
  return out;
}

/** Decode a TOML string literal (basic or literal) into its raw text value. */
function decodeTomlString(lit: string): string {
  if (lit.startsWith('"""') || lit.startsWith("'''")) {
    return lit.slice(3, -3);
  }
  if (lit.startsWith("'")) {
    // Literal string: no escape processing.
    return lit.slice(1, -1);
  }
  // Basic string: process the escapes that matter for paths.
  const inner = lit.slice(1, -1);
  return inner.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/g, (m, g) => {
    switch (g) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        try {
          return String.fromCodePoint(parseInt(g.slice(1), 16));
        } catch {
          return m;
        }
    }
  });
}

/** Match a bare/dotted/quoted header name against the target table name. */
function headerMatchesTarget(raw: string, target: string): boolean {
  const name = raw.trim().replace(/^["']|["']$/g, "").trim();
  return name === target;
}

/**
 * Scan `text` for the target table's `writable_roots` array. Returns a precise
 * discriminated result, or `error` on anything it cannot safely interpret.
 */
function locate(text: string, targetTable: string): Located {
  let i = 0;
  const n = text.length;
  let lineStart = true;
  let currentTable = ""; // "" = root table
  let inTargetTable = false;
  let targetHeaderEnd = -1; // char index after the target header's line (first match)
  let sawDottedTargetPrefix = false; // a root dotted key like `sandbox_workspace_write.*`
  const dottedKeyPath = `${targetTable}.${CODEX_WRITABLE_ROOTS_KEY}`;

  while (i < n) {
    const c = text[i]!;

    if (c === "\n") {
      lineStart = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      continue;
    }

    if (lineStart && c === "[") {
      // Table header (single `[name]` or array-of-tables `[[name]]`).
      const isArrayTable = text[i + 1] === "[";
      const headerOpenLen = isArrayTable ? 2 : 1;
      const closeTok = isArrayTable ? "]]" : "]";
      const close = text.indexOf(closeTok, i + headerOpenLen);
      const nl = text.indexOf("\n", i);
      if (close === -1 || (nl !== -1 && close > nl)) {
        return { kind: "error", reason: "unterminated or multi-line table header" };
      }
      const rawName = text.slice(i + headerOpenLen, close);
      if (/[\n\r]/.test(rawName)) return { kind: "error", reason: "malformed table header" };
      const matches = !isArrayTable && headerMatchesTarget(rawName, targetTable);
      if (isArrayTable && headerMatchesTarget(rawName, targetTable)) {
        // `[[sandbox_workspace_write]]` is not a shape we can safely merge into.
        return { kind: "error", reason: "target is an array-of-tables, not a table" };
      }
      // Advance past the header line.
      const lineEnd = nl === -1 ? n : nl;
      inTargetTable = matches;
      currentTable = rawName.trim().replace(/^["']|["']$/g, "");
      const headerEnd = lineEnd + (nl === -1 ? 0 : 1);
      if (matches && targetHeaderEnd === -1) targetHeaderEnd = headerEnd;
      i = headerEnd;
      lineStart = true;
      continue;
    }

    if (lineStart) {
      // A key assignment: `key = value`. Parse the key token up to `=`.
      const eq = findAssignmentEq(text, i);
      if (eq === -1) return { kind: "error", reason: "line is not a comment, header, or key assignment" };
      const key = text.slice(i, eq).trim().replace(/^["']|["']$/g, "");
      if (key.length === 0) return { kind: "error", reason: "empty key" };
      const valEnd = skipValue(text, eq + 1);
      if (valEnd === -1) return { kind: "error", reason: `unterminated value for key "${key}"` };

      // The fully-qualified key path (dotted keys compose with the active table).
      const fullKey = currentTable ? `${currentTable}.${key}` : key;
      if (currentTable === "" && key.startsWith(`${targetTable}.`)) sawDottedTargetPrefix = true;
      const isOurKey = (inTargetTable && key === CODEX_WRITABLE_ROOTS_KEY) || fullKey === dottedKeyPath;
      if (isOurKey) {
        // Found our key. Its value must be an array.
        let vs = eq + 1;
        while (vs < n && (text[vs] === " " || text[vs] === "\t")) vs++;
        if (text[vs] !== "[") {
          return { kind: "error", reason: "writable_roots is present but is not an array" };
        }
        const arrayEnd = skipBalanced(text, vs);
        if (arrayEnd === -1) return { kind: "error", reason: "unterminated writable_roots array" };
        const elements = parseArrayStrings(text, vs, arrayEnd);
        const multiline = text.slice(vs, arrayEnd + 1).includes("\n");
        return { kind: "key", arrayStart: vs, arrayEnd, elements, multiline };
      }
      i = valEnd;
      lineStart = false;
      continue;
    }

    // Mid-line after a scalar value: advance to the next newline.
    const nl = text.indexOf("\n", i);
    i = nl === -1 ? n : nl;
  }

  if (targetHeaderEnd !== -1) {
    // Target table exists but has no writable_roots key: insert after its header.
    return { kind: "table-no-key", insertAt: targetHeaderEnd };
  }
  if (sawDottedTargetPrefix) {
    // The table is partially defined via root-level dotted keys and has no header.
    // Appending a `[sandbox_workspace_write]` header would redefine the same table
    // (illegal TOML) — refuse rather than risk corrupting the file.
    return {
      kind: "error",
      reason: `${targetTable} is configured via dotted keys; add "${CODEX_WRITABLE_ROOTS_KEY}" under it manually`,
    };
  }
  return { kind: "none" };
}

/** Index of `=` that assigns a key beginning at `i`, or -1 if the line has no top-level `=`. */
function findAssignmentEq(text: string, i: number): number {
  let j = i;
  while (j < text.length) {
    const c = text[j]!;
    if (c === "\n") return -1;
    if (c === "#") return -1;
    if (c === '"' || c === "'") {
      const next = skipString(text, j);
      if (next === -1) return -1;
      j = next;
      continue;
    }
    if (c === "=") return j;
    j++;
  }
  return -1;
}

// ── public merge API ──────────────────────────────────────────────────────────

/**
 * Ensure `ctxHome` is present in `[sandbox_workspace_write].writable_roots` in the
 * Codex config file. Idempotent; byte-stable when the root is already present. Leaves
 * a malformed/unmergeable file completely untouched and returns `error`.
 */
export function ensureCodexWritableRoot(
  configFile: string,
  ctxHome: string,
  platform: NodeJS.Platform = process.platform,
): WritableRootResult {
  const value = tomlRootValue(ctxHome, platform);
  const canonicalTarget = canonicalRoot(value, platform);

  // No file yet (or empty): create a minimal, valid config with just our root. We do
  // NOT set sandbox_mode — forcing workspace-write would change the user's security
  // posture; writable_roots is simply inert if they run read-only.
  if (!existsSync(configFile)) {
    writeFileAtomic(configFile, minimalConfig(value), 0o644);
    return { action: "created" };
  }

  let text: string;
  try {
    text = readFileSync(configFile, "utf8");
  } catch (err) {
    return { action: "error", detail: (err as Error).message };
  }
  if (text.trim().length === 0) {
    writeFileAtomic(configFile, minimalConfig(value), 0o644);
    return { action: "created" };
  }

  const located = locate(text, CODEX_SANDBOX_TABLE);

  if (located.kind === "error") {
    return { action: "error", detail: located.reason };
  }

  if (located.kind === "key") {
    const already = located.elements.some((e) => canonicalRoot(e, platform) === canonicalTarget);
    if (already) return { action: "present" };
    const next =
      text.slice(0, located.arrayStart) +
      rewriteArray(located.elements, value, located.multiline) +
      text.slice(located.arrayEnd + 1);
    writeFileAtomic(configFile, next, 0o644);
    return { action: "added" };
  }

  if (located.kind === "table-no-key") {
    const insertion = `${CODEX_WRITABLE_ROOTS_KEY} = ["${value}"]\n`;
    const next = text.slice(0, located.insertAt) + insertion + text.slice(located.insertAt);
    writeFileAtomic(configFile, next, 0o644);
    return { action: "added" };
  }

  // No target table at all: append a fresh table block, preserving everything before.
  const sep = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  const next = text + sep + minimalConfig(value);
  writeFileAtomic(configFile, next, 0o644);
  return { action: "added" };
}

/**
 * Read-only check: is `ctxHome` already a configured writable root? Tolerant — returns
 * false for a missing or unparseable config (callers surface the remedy separately).
 */
export function codexWritableRootConfigured(
  configFile: string,
  ctxHome: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!existsSync(configFile)) return false;
  let text: string;
  try {
    text = readFileSync(configFile, "utf8");
  } catch {
    return false;
  }
  const located = locate(text, CODEX_SANDBOX_TABLE);
  if (located.kind !== "key") return false;
  const target = canonicalRoot(tomlRootValue(ctxHome, platform), platform);
  return located.elements.some((e) => canonicalRoot(e, platform) === target);
}

function minimalConfig(value: string): string {
  return `[${CODEX_SANDBOX_TABLE}]\n${CODEX_WRITABLE_ROOTS_KEY} = ["${value}"]\n`;
}

/** Rebuild the writable_roots array text with `value` appended, matching the original layout. */
function rewriteArray(elements: string[], value: string, multiline: boolean): string {
  const all = [...elements, value];
  if (multiline) {
    return `[\n${all.map((e) => `  "${e}",`).join("\n")}\n]`;
  }
  return `[${all.map((e) => `"${e}"`).join(", ")}]`;
}
