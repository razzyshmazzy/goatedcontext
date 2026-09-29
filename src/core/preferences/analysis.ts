/**
 * Deterministic, dependency-free text analysis used by dedup, conflict
 * resolution and retrieval. No LLM, no embeddings.
 *
 * Three signals are extracted from a rule or task string:
 *   1. subject tokens  — the "what" of the rule, with polarity/filler removed,
 *      so that "Use Redis" and "Never use Redis" share the same subject.
 *   2. polarity        — positive | negative | neutral, so opposite directives
 *      are never treated as the same rule.
 *   3. domain          — a coarse decision area (package-manager, database, …)
 *      used for conflict detection, precedence and retrieval filtering.
 */

export type Polarity = "positive" | "negative" | "neutral";

/** Structural / low-signal words removed from all token sets. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
  "before", "after", "than", "then", "this", "that", "these", "those", "is",
  "are", "be", "as", "at", "by", "it", "its", "into", "when", "if", "we", "you",
  "i", "should", "would", "could", "please", "another", "new", "existing",
  "unless", "necessary", "only", "once", "our", "your", "their", "there",
  "here", "which", "while", "about", "from", "up", "out", "over", "per",
]);

/**
 * Generic engineering verbs that appear in almost every task/rule and therefore
 * carry almost no discriminating signal. Removed from subject/relevance tokens
 * so "Add X" no longer spuriously matches "…before adding Y".
 */
const GENERIC_VERBS = new Set([
  "add", "change", "create", "make", "implement", "update", "fix", "set",
  "build", "write", "introduce", "keep", "handle", "support", "provide",
  "ensure", "allow", "enable", "get", "run", "call",
]);

/** Words that signal an affirmative directive. */
const POSITIVE_MARKERS = new Set([
  "use", "prefer", "always", "require", "required", "must", "adopt", "favor",
  "favour", "choose", "enforce", "standardize",
]);

/** Single-word negation markers (multi-word handled separately). */
const NEGATIVE_MARKERS = new Set([
  "avoid", "never", "no", "not", "without", "disallow", "forbid", "prohibit",
  "ban", "dont", "cant", "wont", "avoiding",
]);

/**
 * Domain catalogue. `exclusive` domains admit a single winning choice (you can
 * only pick one package manager), so any two active preferences in the domain
 * conflict and precedence decides. Non-exclusive domains are policy areas where
 * multiple compatible rules can coexist.
 *
 * The list is intentionally small and easy to extend — it is not a taxonomy.
 */
export interface DomainDef {
  exclusive: boolean;
  keywords: string[];
}

export const DOMAINS: Record<string, DomainDef> = {
  "package-manager": {
    exclusive: true,
    keywords: ["npm", "pnpm", "yarn", "bun", "package manager", "packagemanager"],
  },
  database: {
    exclusive: true,
    keywords: [
      "database", "db", "postgres", "postgresql", "sqlite", "mysql", "mariadb",
      "sql", "schema", "migration", "relational", "persistence", "persist",
      "table", "index", "constraint", "invariant",
    ],
  },
  "ui-framework": {
    exclusive: true,
    keywords: [
      "react", "vue", "svelte", "angular", "component", "button", "css",
      "tailwind", "ui", "frontend", "color", "colour", "styling", "widget",
    ],
  },
  "state-management": {
    exclusive: true,
    keywords: ["redux", "zustand", "mobx", "state", "store", "signal"],
  },
  "dependency-policy": {
    exclusive: false,
    keywords: [
      "dependency", "dependencies", "package", "packages", "library",
      "libraries", "install", "third-party", "vendor", "import",
    ],
  },
  testing: {
    exclusive: false,
    keywords: [
      "test", "tests", "testing", "spec", "coverage", "tdd", "vitest", "jest",
      "mock", "assertion", "fixture",
    ],
  },
  architecture: {
    exclusive: false,
    keywords: [
      "architecture", "service", "layer", "abstraction", "module", "boundary",
      "microservice", "monolith", "coupling", "pattern", "structure", "domain",
      "design", "refactor",
    ],
  },
  "error-handling": {
    exclusive: false,
    keywords: [
      "error", "exception", "catch", "defensive", "retry", "fallback",
      "root cause", "failure", "recover", "workaround",
    ],
  },
  formatting: {
    exclusive: false,
    keywords: [
      "format", "formatting", "prettier", "eslint", "lint", "indentation",
      "whitespace", "semicolon", "quotes", "style", "date", "timestamp",
    ],
  },
  infrastructure: {
    exclusive: false,
    keywords: [
      "docker", "kubernetes", "redis", "cache", "caching", "queue", "kafka",
      "terraform", "deploy", "infrastructure", "distributed", "memcached",
    ],
  },
  // The natural language Claude should respond in — a single-choice decision, so
  // "respond in Italian" and "respond in English" compete and precedence decides
  // (e.g. a repo rule overrides a global one). Deliberately keyed on human-language
  // NAMES only (not the word "language") to avoid matching "typed language" etc.
  "response-language": {
    exclusive: true,
    keywords: [
      "italian", "english", "spanish", "french", "german", "portuguese",
      "japanese", "chinese", "korean", "russian", "dutch", "locale",
    ],
  },
};

/** Known domain names, exported for validation and help text. */
export const KNOWN_DOMAINS = Object.keys(DOMAINS);

/**
 * Precomputed match index. Single-word keywords are stemmed and de-duplicated so
 * that synonyms which stem to the same token (e.g. "dependency"/"dependencies")
 * count as ONE signal, not two — otherwise hit counts get inflated and domain
 * inference picks the wrong domain.
 */
interface DomainIndexEntry {
  exclusive: boolean;
  stems: Set<string>;
  phrases: string[];
}
const DOMAIN_INDEX: Record<string, DomainIndexEntry> = buildDomainIndex();

function buildDomainIndex(): Record<string, DomainIndexEntry> {
  const idx: Record<string, DomainIndexEntry> = {};
  for (const [name, def] of Object.entries(DOMAINS)) {
    const stems = new Set<string>();
    const phrases: string[] = [];
    for (const kw of def.keywords) {
      if (kw.includes(" ")) phrases.push(kw);
      else stems.add(stem(kw));
    }
    idx[name] = { exclusive: def.exclusive, stems, phrases };
  }
  return idx;
}

/** Very light stemmer: collapse common plural/verb suffixes deterministically. */
export function stem(token: string): string {
  return token
    .replace(/(ies)$/, "y")
    .replace(/(ing|ed|es|s)$/, "")
    .replace(/y$/, "");
}

function rawTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** All meaningful content tokens (stemmed), stopwords removed. */
export function contentTokens(text: string): string[] {
  return rawTokens(text)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

/**
 * Subject tokens: content tokens with polarity markers and generic verbs
 * removed. This is the "what" the rule is about, independent of direction.
 */
export function subjectTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawTokens(text)) {
    if (raw.length <= 1) continue;
    if (STOPWORDS.has(raw)) continue;
    if (POSITIVE_MARKERS.has(raw)) continue;
    if (NEGATIVE_MARKERS.has(raw)) continue;
    if (GENERIC_VERBS.has(raw)) continue;
    const s = stem(raw);
    if (s.length <= 1) continue;
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/** Stable canonical subject key (sorted subject tokens). */
export function subjectKey(text: string): string {
  return subjectTokens(text).slice().sort().join(" ");
}

/**
 * Determine directive polarity. Negation is detected on the raw lowercased text
 * (including multi-word forms and contractions) so it is never silently dropped.
 */
export function polarity(text: string): Polarity {
  const t = text.toLowerCase();
  const negative =
    /\b(?:never|avoid|do\s?not|don'?t|does\s?not|doesn'?t|did\s?not|didn'?t|must\s?not|mustn'?t|should\s?not|shouldn'?t|can\s?not|cannot|can'?t|will\s?not|won'?t|without|disallow|forbid|prohibit|ban|refrain|no|not)\b/.test(
      t,
    );
  if (negative) return "negative";
  const positive = rawTokens(t).some((w) => POSITIVE_MARKERS.has(w));
  return positive ? "positive" : "neutral";
}

/**
 * Infer the set of decision domains a piece of text touches. Multi-word
 * keywords are matched against the phrase; single-word keywords against the
 * stemmed token set. Returns every domain with at least one hit.
 */
export function inferDomains(text: string): Set<string> {
  const tokens = new Set(contentTokens(text));
  const phrase = phraseForm(text);
  const domains = new Set<string>();
  for (const [name, def] of Object.entries(DOMAIN_INDEX)) {
    if (countHits(def, tokens, phrase) > 0) domains.add(name);
  }
  return domains;
}

/**
 * Infer the single best domain for a preference (its rule + optional category),
 * or null if nothing matches. Deterministic: most distinct keyword hits wins,
 * ties broken by declaration order in DOMAINS.
 */
export function inferPrimaryDomain(text: string, category?: string): string | null {
  const haystack = category ? `${text} ${category}` : text;
  const tokens = new Set(contentTokens(haystack));
  const phrase = phraseForm(haystack);
  let best: string | null = null;
  let bestHits = 0;
  for (const [name, def] of Object.entries(DOMAIN_INDEX)) {
    let hits = countHits(def, tokens, phrase);
    // Category naming the domain directly is a strong signal.
    if (category && category.trim().toLowerCase() === name) hits += 2;
    if (hits > bestHits) {
      bestHits = hits;
      best = name;
    }
  }
  return best;
}

function phraseForm(text: string): string {
  return " " + text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim() + " ";
}

function countHits(def: DomainIndexEntry, tokens: Set<string>, phrase: string): number {
  let hits = 0;
  for (const s of def.stems) if (tokens.has(s)) hits++;
  for (const p of def.phrases) if (phrase.includes(" " + p + " ")) hits++;
  return hits;
}

/** Whether a domain is single-choice (any two active prefs in it conflict). */
export function isExclusiveDomain(domain: string | null): boolean {
  return domain != null && DOMAINS[domain]?.exclusive === true;
}

/**
 * Leading universal-directive phrases that make a rule apply to EVERY prompt
 * regardless of the task. Anchored at the start of the (trimmed, lowercased) rule
 * so we never fire on the word merely appearing mid-sentence — that is what keeps
 * "Prefer functions that never throw" or "Prefer an always-visible toolbar"
 * classified as `relevant`. The `(?![-\w])` guards reject hyphenated compounds
 * such as "always-on" / "never-ending".
 */
const ALWAYS_LEADERS: RegExp[] = [
  /^always(?![-\w])/,
  /^never(?![-\w])/,
  /^every\s+time\b/,
  /^for\s+(?:every|all|each)\s+tasks?\b/,
  /^regardless\s+of\s+(?:the\s+)?(?:task|context)\b/,
  /^whenever\s+you\b/,
];

/**
 * Conservatively infer whether a rule is a universal directive (`always`) or a
 * task-relevant memory (`relevant`). Deterministic and dependency-free; used only
 * when the caller does not pass an explicit applicability. Biased hard toward
 * `relevant`: it fires `always` only for an unmistakable leading directive, never
 * on soft words like "prefer"/"should"/"usually"/"generally".
 */
export function inferApplicability(rule: string): "relevant" | "always" {
  const t = rule.trim().toLowerCase();
  return ALWAYS_LEADERS.some((re) => re.test(t)) ? "always" : "relevant";
}
