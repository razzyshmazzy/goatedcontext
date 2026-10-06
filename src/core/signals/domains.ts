import { normalizeDomain } from "./normalize.ts";
import { contentTokens, inferDomains, stem } from "../preferences/analysis.ts";
import type { RuntimeContext } from "../retrieval/runtime-context.ts";

/**
 * The canonical DECISION-DOMAIN alias layer (0.3.4).
 *
 * Signals are recorded in whatever domain word the developer/agent used
 * (`backend`, `db`, `frontend-framework`, …). The runtime task classifier
 * (`analysis.ts` → `inferDomains`) speaks a slightly different vocabulary
 * (`ui-framework`, `package-manager`, …). For automatic signal surfacing to work,
 * the two must agree on a SHARED canonical token — otherwise a task about the
 * "frontend" would never match a signal domain spelled "frontend-framework".
 *
 * This file is that bridge, and it is deliberately TINY and EXPLICIT — a small
 * hand-written alias table plus a handful of task-intent triggers for the few
 * domains the preference classifier does not cover (there is no `backend` domain
 * in the classifier, and "initialize this project" names no package manager). It
 * is NOT a second semantic-retrieval system, NOT an ontology, and NOT an
 * embedding: every mapping is a literal string equality. Adding a mapping is a
 * one-line edit, reviewed here.
 */

/**
 * Raw (normalized) domain → canonical domain. Identity for anything not listed.
 * Keep this list short; each entry is reported in the changelog. The right-hand
 * canonical tokens are the ones the task matcher and the renderer use.
 */
export const DOMAIN_ALIASES: Record<string, string> = {
  // database
  db: "database",
  databases: "database",
  datastore: "database",
  // frontend (the classifier calls this "ui-framework")
  ui: "frontend",
  "ui-framework": "frontend",
  "frontend-framework": "frontend",
  "front-end": "frontend",
  styling: "frontend",
  // backend (the classifier has NO backend domain — this is the main gap)
  "backend-framework": "backend",
  "back-end": "backend",
  server: "backend",
  api: "backend",
  // package manager
  pm: "package-manager",
  "package-managers": "package-manager",
  "pkg-manager": "package-manager",
  // testing (the classifier calls this "testing")
  test: "testing",
  tests: "testing",
  "test-framework": "testing",
  "testing-framework": "testing",
  // misc short forms
  state: "state-management",
  infra: "infrastructure",
};

/**
 * Task-intent triggers for canonical domains the preference classifier does NOT
 * already detect. The classifier's own keywords (npm/react/postgres/vitest/…) are
 * reused via `inferDomains`, so this table only fills real gaps:
 *   - `backend`  — not a classifier domain at all;
 *   - `package-manager` — project-bootstrapping language ("initialize this project")
 *     names no package manager, yet is exactly when prior PM choices are relevant.
 * Single tokens are matched (stemmed) against the task's content tokens; entries
 * with a space are matched as a phrase against the normalized task text.
 */
export const DOMAIN_TRIGGERS: Record<string, string[]> = {
  backend: [
    "backend",
    "back end",
    "server",
    "server side",
    "serverside",
    "api",
    "supabase",
    "firebase",
    "convex",
    "appwrite",
    "pocketbase",
  ],
  "package-manager": [
    "package manager",
    "initialize",
    "initialise",
    "init",
    "scaffold",
    "bootstrap",
    "new project",
    "project setup",
    "set up project",
    "install dependencies",
  ],
};

/** Canonicalize any raw/normalized domain token to its shared canonical form. */
export function canonicalDomain(raw: string): string {
  const n = normalizeDomain(raw);
  return DOMAIN_ALIASES[n] ?? n;
}

/**
 * Given canonical domains, return every RAW domain spelling that canonicalizes to
 * one of them (including the canonical token itself). Used to build an indexed
 * `WHERE domain IN (…)` query so the hot retrieval path reads only matching-domain
 * signal rows — never a full-table scan — and still catches aliased spellings.
 */
export function expandCanonicalToRaw(canonicalDomains: Iterable<string>): string[] {
  const wanted = new Set<string>();
  for (const c of canonicalDomains) wanted.add(c);
  const out = new Set<string>(wanted);
  for (const [raw, canon] of Object.entries(DOMAIN_ALIASES)) {
    if (wanted.has(canon)) out.add(raw);
  }
  return [...out];
}

/** Normalized, space-padded phrase form of a task, for multi-word trigger matching. */
function phraseForm(text: string): string {
  return " " + text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim() + " ";
}

/**
 * The set of canonical decision domains a piece of text is "about". Reuses the
 * existing preference classifier (`inferDomains`, canonicalized) and then adds the
 * tiny trigger table for the gaps. Pure and deterministic.
 */
export function collectDomainsFromText(text: string): Set<string> {
  const out = new Set<string>();
  for (const d of inferDomains(text)) out.add(canonicalDomain(d));
  const tokens = new Set(contentTokens(text));
  const phrase = phraseForm(text);
  for (const [canon, triggers] of Object.entries(DOMAIN_TRIGGERS)) {
    for (const t of triggers) {
      const hit = t.includes(" ") ? phrase.includes(` ${t} `) : tokens.has(stem(t));
      if (hit) {
        out.add(canon);
        break;
      }
    }
  }
  return out;
}

/**
 * The canonical decision domains the CURRENT TASK touches. This is what gates
 * automatic signal surfacing: signal evidence is only ever considered for a domain
 * in this set, so an unrelated prompt injects no signals at all. An explicit
 * runtime `domain` (from the simulator or a future adapter) is honored verbatim.
 */
export function taskSignalDomains(rc: RuntimeContext): Set<string> {
  const out = new Set<string>();
  if (rc.domain) out.add(canonicalDomain(rc.domain));
  if (rc.task) for (const d of collectDomainsFromText(rc.task)) out.add(d);
  return out;
}
