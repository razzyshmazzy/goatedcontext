/**
 * A tiny, dependency-free glob matcher for repo-relative, forward-slash paths.
 *
 * goatedcontext deliberately avoids adding a glob dependency just for file
 * conditions (the only existing deps are commander + zod). The supported subset is
 * the common, well-understood one used by `.gitignore`-style and editor patterns:
 *
 *   *   — matches any run of characters WITHIN a single path segment (not `/`)
 *   **  — matches any number of whole segments, including none (crosses `/`)
 *   ?   — matches exactly one character within a segment (not `/`)
 *   everything else is a literal
 *
 * Patterns and paths are normalized to forward slashes first, so a Windows path
 * such as `src\components\App.tsx` matches `**\/*.tsx`. Matching is deterministic,
 * anchored at both ends, and has no filesystem access — it is pure string logic.
 */

/** Normalize a path/pattern to forward slashes, trimmed, with no leading `./`. */
export function normalizeSlashes(p: string): string {
  let s = p.replace(/\\/g, "/").trim();
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

/** Escape a run of literal characters for use inside a RegExp. */
function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Translate a glob into an anchored RegExp source. `**` is handled with awareness
 * of an adjacent `/` so that `a/**\/b` matches both `a/b` and `a/x/y/b`.
 */
function globToRegExpSource(glob: string): string {
  const g = normalizeSlashes(glob);
  let out = "";
  let i = 0;
  while (i < g.length) {
    const c = g[i]!;
    if (c === "*") {
      const doubleStar = g[i + 1] === "*";
      if (doubleStar) {
        // Consume the run of stars.
        i += 2;
        const nextIsSlash = g[i] === "/";
        if (nextIsSlash) {
          // `**/` — match zero or more leading segments (including none).
          out += "(?:[^/]*(?:/|$))*";
          i += 1;
        } else {
          // `**` not followed by `/` — match anything, including `/`.
          out += "[\\s\\S]*";
        }
      } else {
        // Single `*` — anything except a path separator.
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += escapeLiteral(c);
      i += 1;
    }
  }
  return "^" + out + "$";
}

/** True when `path` matches `pattern` under the supported glob semantics. */
export function matchGlob(pattern: string, path: string): boolean {
  const p = normalizeSlashes(path);
  const re = new RegExp(globToRegExpSource(pattern));
  return re.test(p);
}

/** True when any of `paths` matches `pattern`. */
export function anyMatchesGlob(pattern: string, paths: readonly string[]): boolean {
  const re = new RegExp(globToRegExpSource(pattern));
  return paths.some((p) => re.test(normalizeSlashes(p)));
}

/** The first path that matches `pattern`, or null. Used for explainability. */
export function firstMatchingPath(pattern: string, paths: readonly string[]): string | null {
  const re = new RegExp(globToRegExpSource(pattern));
  for (const p of paths) {
    const n = normalizeSlashes(p);
    if (re.test(n)) return n;
  }
  return null;
}
