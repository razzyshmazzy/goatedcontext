import { contentTokens, subjectKey, subjectTokens } from "./analysis.ts";

/**
 * Text similarity seam. Implemented deterministically today (subject-token
 * Jaccard); the interface is where semantic embeddings could be swapped in later
 * without changing callers.
 *
 * IMPORTANT: `normalize`/`score` operate on SUBJECT tokens only (polarity and
 * generic verbs removed). Polarity is handled separately by the analysis module
 * so that opposite directives are never collapsed together.
 */
export interface Similarity {
  /** Subject similarity in [0, 1]. */
  score(a: string, b: string): number;
  /** Canonical subject key (stable dedup/index value). */
  normalize(text: string): string;
}

export class JaccardSimilarity implements Similarity {
  normalize(text: string): string {
    return subjectKey(text);
  }

  score(a: string, b: string): number {
    return jaccard(new Set(subjectTokens(a)), new Set(subjectTokens(b)));
  }
}

function jaccard(sa: Set<string>, sb: Set<string>): number {
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const t of sa) if (sb.has(t)) intersection++;
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Convenience: content-token overlap fraction of the query (used in tests/tools). */
export function contentOverlap(query: string, target: string): number {
  const qs = new Set(contentTokens(query));
  const ts = new Set(contentTokens(target));
  if (qs.size === 0) return 0;
  let hits = 0;
  for (const t of qs) if (ts.has(t)) hits++;
  return hits / qs.size;
}
