/**
 * Deterministic programming-language normalization and inference.
 *
 * Conditional preferences (`ctx remember --when language=typescript …`) carry a
 * CANONICAL language name. User input and aliases (`ts`, `py`, `c++`) are mapped to
 * that canonical name here, and unknown languages are rejected — never guessed.
 *
 * Language is inferred ONLY from concrete runtime information (file extensions),
 * never from task text: "add a type annotation" must not imply TypeScript. If no
 * file is known, no language is established, so a language condition cannot match.
 */

/** The canonical languages 0.2.8 understands. Intentionally small and explicit. */
export const CANONICAL_LANGUAGES = [
  "typescript",
  "javascript",
  "python",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "php",
  "swift",
  "kotlin",
  "html",
  "css",
  "sql",
] as const;

export type CanonicalLanguage = (typeof CANONICAL_LANGUAGES)[number];

const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_LANGUAGES);

/**
 * Aliases → canonical name. Canonical names map to themselves implicitly. Keys are
 * matched after trimming + lowercasing the input, so `TS`, ` ts `, `TypeScript` all
 * resolve. Only obvious, unambiguous aliases are listed — nothing fuzzy.
 */
const ALIASES: Record<string, CanonicalLanguage> = {
  ts: "typescript",
  tsx: "typescript",
  "typescript": "typescript",
  js: "javascript",
  jsx: "javascript",
  node: "javascript",
  nodejs: "javascript",
  py: "python",
  py3: "python",
  python3: "python",
  rs: "rust",
  golang: "go",
  "c++": "cpp",
  cplusplus: "cpp",
  cxx: "cpp",
  cc: "cpp",
  cs: "csharp",
  "c#": "csharp",
  dotnet: "csharp",
  rb: "ruby",
  kt: "kotlin",
  htm: "html",
  postgres: "sql",
  postgresql: "sql",
};

/**
 * Resolve a user-supplied language string to its canonical name, or null if it is
 * not a language 0.2.8 recognizes. Deterministic and case-insensitive.
 */
export function normalizeLanguage(input: string): CanonicalLanguage | null {
  const key = input.trim().toLowerCase();
  if (key.length === 0) return null;
  if (CANONICAL_SET.has(key)) return key as CanonicalLanguage;
  return ALIASES[key] ?? null;
}

/**
 * File extension (no dot, lowercased) → canonical language. Only concrete,
 * unambiguous mappings. Extensions absent here establish no language.
 */
const EXT_TO_LANGUAGE: Record<string, CanonicalLanguage> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  html: "html",
  htm: "html",
  css: "css",
  sql: "sql",
};

/** Canonical language for a single (already repo-relative, forward-slash) path. */
export function languageForPath(path: string): CanonicalLanguage | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_LANGUAGE[ext] ?? null;
}

/**
 * Infer the set of canonical languages present in a list of file paths, by
 * extension only. Returns an empty set when no path maps to a known language.
 */
export function inferLanguagesFromFiles(files: readonly string[]): Set<string> {
  const langs = new Set<string>();
  for (const f of files) {
    const lang = languageForPath(f);
    if (lang) langs.add(lang);
  }
  return langs;
}
