/**
 * A LOCAL mirror of goatedcontext's stable `ctx agent context --json` envelope (v1).
 *
 * The envelope is explicitly designed to be consumed "without importing any
 * goatedcontext TypeScript" (see src/core/agents/envelope.ts). The benchmark honors
 * that contract: it re-declares only the fields it reads, so it stays a true black-box
 * consumer and a product refactor cannot silently drag benchmark code along with it.
 * Additive v1 fields are ignored (forward-compatible by design).
 */
export interface EnvelopePreference {
  rule: string;
  scope: string;
  domain: string | null;
  applicability: string;
  confidence: number;
}

export interface EnvelopeDiagnostics {
  candidate: number;
  effective: number;
  delivered: number;
  authoritative: number;
  observedPatterns: number;
  /** Characters of the canonical rendered block — the ctx context-cost metric (§38). */
  renderedChars: number;
  /** chars/4 token estimate — indicative, not a tokenizer. */
  approxTokens: number;
  omittedByRelevance: number;
  omittedByBudget: number;
  overflow: boolean;
}

export interface ContextEnvelopeV1 {
  version: number;
  context: {
    authoritativePreferences: EnvelopePreference[];
    observedPatterns: Array<{ domain: string; contradictory: boolean }>;
    proposals?: Array<{ rule: string; authoritative: false }>;
  };
  meta: {
    repo: boolean;
    repoName: string | null;
    domains: string[];
    diagnostics: EnvelopeDiagnostics;
  };
}
