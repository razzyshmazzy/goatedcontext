/**
 * Deterministic, dependency-free text similarity used for two things:
 *  1. de-duplicating proposed preferences (so `ctx propose` accretes evidence
 *     onto an existing suggestion instead of spawning near-duplicates), and
 *  2. relevance ranking in retrieval.
 *
 * This is intentionally simple (token-set Jaccard with light stemming). The
 * `Similarity` interface is the seam where semantic embeddings can be swapped in
 * later without changing any caller.
 */
export interface Similarity {
  /** Similarity score in [0, 1]. */
  score(a: string, b: string): number;
  /** Normalized form of a string, used as a stable dedup/index key. */
  normalize(text: string): string;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
  "before", "after", "than", "then", "this", "that", "these", "those", "is",
  "are", "be", "as", "at", "by", "it", "its", "into", "when", "if", "do",
  "does", "not", "no", "we", "you", "i", "should", "would", "prefer", "use",
  "using", "please", "always", "never",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(stem);
}

/** Extremely light stemmer: collapse common plural/verb suffixes. */
function stem(token: string): string {
  return token
    .replace(/(ies)$/, "y")
    .replace(/(ing|ed|es|s)$/, "")
    .replace(/y$/, "");
}

function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export class JaccardSimilarity implements Similarity {
  normalize(text: string): string {
    return contentTokens(text).sort().join(" ");
  }

  score(a: string, b: string): number {
    const sa = new Set(contentTokens(a));
    const sb = new Set(contentTokens(b));
    if (sa.size === 0 || sb.size === 0) return 0;
    let intersection = 0;
    for (const t of sa) if (sb.has(t)) intersection++;
    const union = sa.size + sb.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}

/**
 * Overlap score biased toward the query: how much of the query's content is
 * covered by the target. Better than Jaccard for ranking a long rule against a
 * short task description.
 */
export function coverageScore(query: string, target: string, sim: Similarity): number {
  const qs = new Set(contentTokens(query));
  const ts = new Set(contentTokens(target));
  if (qs.size === 0 || ts.size === 0) return 0;
  let hits = 0;
  for (const t of qs) if (ts.has(t)) hits++;
  const coverage = hits / qs.size;
  // Blend coverage with symmetric similarity for stability.
  return 0.7 * coverage + 0.3 * sim.score(query, target);
}
