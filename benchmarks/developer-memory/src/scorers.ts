/**
 * Deterministic, behavior-first scorers (spec §20–21).
 *
 * Every scorer is a PURE function of the agent's `ObservedBehavior` (the commands it
 * ran and the files it wrote). None of them look at the agent's prose: an agent that
 * says "I remembered you prefer Bun" but runs `npm install` FAILS (spec §20). This is
 * the whole point — we score behavior, not claims.
 */
import type { ObservedBehavior, Scorer } from "./schema.ts";

export interface ScoreResult {
  pass: boolean;
  /** Human-readable justification, for failure examples and debugging (spec §57). */
  reason: string;
}

/** A pattern is a regex if written `/…/flags`, otherwise a case-insensitive substring. */
function matches(haystack: string, pattern: string): boolean {
  const re = asRegex(pattern);
  if (re) return re.test(haystack);
  return haystack.toLowerCase().includes(pattern.toLowerCase());
}

function asRegex(pattern: string): RegExp | null {
  const m = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  if (!m) return null;
  try {
    return new RegExp(m[1]!, m[2]);
  } catch {
    return null;
  }
}

function anyCommandMatches(b: ObservedBehavior, pattern: string): boolean {
  return b.commands.some((c) => matches(c, pattern));
}

function editedPaths(b: ObservedBehavior): string[] {
  return Object.keys(b.files);
}

function pathHasExt(path: string, ext: string): boolean {
  const clean = ext.startsWith(".") ? ext.slice(1) : ext;
  return path.toLowerCase().endsWith("." + clean.toLowerCase());
}

/**
 * The package-manager detector used by `packageAdded` and by `exactChoice`'s rival
 * detection. Returns true iff the behavior shows `pkg` being added through `tool` —
 * either an explicit add command, or a manifest/lockfile fingerprint of that tool.
 */
function packageAddedVia(
  b: ObservedBehavior,
  pkg: string,
  tool: "bun" | "npm" | "pnpm" | "yarn",
): boolean {
  const addVerb: Record<string, RegExp> = {
    bun: /\bbun\s+(add|install|i)\b/i,
    npm: /\bnpm\s+(install|i|add)\b/i,
    pnpm: /\bpnpm\s+(add|install|i)\b/i,
    yarn: /\byarn\s+(add|install)\b/i,
  };
  const pkgRe = new RegExp(`\\b${escapeRe(pkg)}\\b`, "i");
  // Command evidence: a matching add verb for this tool naming the package.
  const cmdHit = b.commands.some((c) => addVerb[tool]!.test(c) && pkgRe.test(c));
  if (cmdHit) return true;

  // Lockfile evidence: the tool's lockfile was written.
  const lockfiles: Record<string, string> = {
    bun: "bun.lock",
    npm: "package-lock.json",
    pnpm: "pnpm-lock.yaml",
    yarn: "yarn.lock",
  };
  const lf = lockfiles[tool]!;
  const wroteLock = editedPaths(b).some((p) => p.toLowerCase().endsWith(lf));
  if (wroteLock && manifestMentions(b, pkg)) return true;

  return false;
}

function manifestMentions(b: ObservedBehavior, pkg: string): boolean {
  const pkgJson = Object.entries(b.files).find(([p]) => p.toLowerCase().endsWith("package.json"));
  if (!pkgJson) return false;
  return new RegExp(`"${escapeRe(pkg)}"\\s*:`).test(pkgJson[1]);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function score(scorer: Scorer, b: ObservedBehavior): ScoreResult {
  switch (scorer.kind) {
    case "commandContains": {
      const pass = anyCommandMatches(b, scorer.pattern);
      return { pass, reason: pass ? `a command matched ${scorer.pattern}` : `no command matched ${scorer.pattern}` };
    }
    case "commandNotContains": {
      const hit = scorer.patterns.find((p) => anyCommandMatches(b, p));
      return hit
        ? { pass: false, reason: `forbidden command pattern matched: ${hit}` }
        : { pass: true, reason: "no forbidden command pattern matched" };
    }
    case "fileExists": {
      const pass = editedPaths(b).some((p) => matches(p, scorer.pathPattern));
      return { pass, reason: pass ? `a file matched ${scorer.pathPattern}` : `no file matched ${scorer.pathPattern}` };
    }
    case "fileExtension": {
      const hit = editedPaths(b).find((p) => scorer.anyOf.some((e) => pathHasExt(p, e)));
      return hit
        ? { pass: true, reason: `wrote ${hit}` }
        : { pass: false, reason: `no file with extension in [${scorer.anyOf.join(", ")}]` };
    }
    case "fileExtensionNotAnyOf": {
      const hit = editedPaths(b).find((p) => scorer.noneOf.some((e) => pathHasExt(p, e)));
      return hit
        ? { pass: false, reason: `wrote forbidden-extension file ${hit}` }
        : { pass: true, reason: `no file with extension in [${scorer.noneOf.join(", ")}]` };
    }
    case "fileContains": {
      const entries = Object.entries(b.files).filter(
        ([p]) => !scorer.pathPattern || matches(p, scorer.pathPattern),
      );
      const hit = entries.find(([, content]) => matches(content, scorer.pattern));
      return hit
        ? { pass: true, reason: `${hit[0]} matched ${scorer.pattern}` }
        : { pass: false, reason: `no file content matched ${scorer.pattern}` };
    }
    case "packageAdded": {
      const pass = packageAddedVia(b, scorer.pkg, scorer.tool);
      return {
        pass,
        reason: pass
          ? `${scorer.pkg} added via ${scorer.tool}`
          : `${scorer.pkg} not added via ${scorer.tool}`,
      };
    }
    case "frameworkDetected": {
      const pass = detectFramework(b, scorer.framework);
      return { pass, reason: pass ? `detected ${scorer.framework}` : `did not detect ${scorer.framework}` };
    }
    case "exactChoice": {
      const choseRival = scorer.notOneOf.find((r) => choiceDetected(b, r));
      if (choseRival) return { pass: false, reason: `chose forbidden rival "${choseRival}"` };
      const chosePreferred = choiceDetected(b, scorer.choice);
      return chosePreferred
        ? { pass: true, reason: `chose "${scorer.choice}"` }
        : { pass: false, reason: `did not choose "${scorer.choice}" (and no rival either)` };
    }
    case "noForbiddenChoice": {
      const hit = scorer.forbidden.find((f) => choiceDetected(b, f));
      return hit
        ? { pass: false, reason: `applied forbidden choice "${hit}" (false positive)` }
        : { pass: true, reason: "no forbidden choice applied (correct abstention)" };
    }
    case "all": {
      const results = scorer.scorers.map((s) => score(s, b));
      const failed = results.find((r) => !r.pass);
      return failed ? { pass: false, reason: `all: ${failed.reason}` } : { pass: true, reason: "all sub-scorers passed" };
    }
    case "any": {
      const results = scorer.scorers.map((s) => score(s, b));
      const passed = results.find((r) => r.pass);
      return passed ? { pass: true, reason: `any: ${passed.reason}` } : { pass: false, reason: "no sub-scorer passed" };
    }
  }
}

/**
 * Generic "did the agent choose X" detector, where X is a tool/library/framework/db
 * token. Looks at commands and file contents (NOT prose). Used by exactChoice and
 * the abstention scorer. A token like "bun" matches `bun add`, a bun.lock file, etc.
 */
function choiceDetected(b: ObservedBehavior, token: string): boolean {
  const re = asRegex(token) ?? new RegExp(`\\b${escapeRe(token)}\\b`, "i");
  if (b.commands.some((c) => re.test(c))) return true;
  // File path or contents mentioning the token (import, config key, dependency).
  for (const [p, content] of Object.entries(b.files)) {
    if (re.test(p) || re.test(content)) return true;
  }
  return false;
}

/** Framework fingerprints: command + import/config signatures (spec §21). */
function detectFramework(b: ObservedBehavior, framework: string): boolean {
  const f = framework.toLowerCase();
  const sigs: Record<string, RegExp[]> = {
    vitest: [/\bvitest\b/i, /from ['"]vitest['"]/i],
    jest: [/\bjest\b/i, /from ['"]@jest\//i],
    react: [/from ['"]react['"]/i, /\.jsx\b/i, /\.tsx\b/i],
    postgres: [/\bpostgres(ql)?\b/i, /\bpg\b/i, /\bpsql\b/i],
    mysql: [/\bmysql2?\b/i],
    sqlite: [/\bsqlite3?\b/i, /\bbetter-sqlite3\b/i, /:memory:/i, /\.db\b/i],
    tailwind: [/\btailwindcss\b/i, /@tailwind\b/i],
    express: [/from ['"]express['"]/i, /require\(['"]express['"]\)/i],
  };
  const patterns = sigs[f] ?? [new RegExp(`\\b${escapeRe(f)}\\b`, "i")];
  const hay = [...b.commands, ...Object.keys(b.files), ...Object.values(b.files)];
  return patterns.some((re) => hay.some((h) => re.test(h)));
}
