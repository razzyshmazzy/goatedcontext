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

/**
 * DEPENDENCY-ACQUISITION intent (F3). Terse coding requests — "add uuid", "pull in
 * dayjs", "install the redis client" — are *exactly* when a stored package-manager
 * preference ("use pnpm") is relevant, yet they name no package manager and the
 * preference classifier infers at most `dependency-policy`, never `package-manager`.
 * So the pref gets no domain match and falls below the relevance threshold (the F3
 * delivery miss observed on the v1.1 benchmark).
 *
 * This recognizes the ACTION of bringing an external dependency into the project —
 * never specific package names (a package-name list is unmaintainable and spec §52
 * forbids scenario-specific vocabulary). It is deliberately CONSERVATIVE so ordinary
 * feature work ("add a button", "add caching", "add validation for the form") and the
 * innocent phrasal uses ("pull in the latest changes") do NOT fire. Pure/deterministic.
 */
const ACQUIRE_VERBS = new Set([
  "add", "adds", "adding", "install", "installs", "installing", "vendor", "vendoring",
]);
const ACQUIRE_PHRASALS = ["pull in", "bring in", "depend on", "pulling in", "bringing in"];
/** Determiners marking the object as an in-place feature, not a bare package name. */
const OBJECT_DETERMINERS = new Set([
  "a", "an", "the", "some", "this", "that", "these", "those", "our", "your", "their",
  "its", "each", "every", "another", "no", "more", "all",
]);
/** Common objects of "pull in"/"bring in" that are NOT packages (VCS / people / generic). */
const NON_PACKAGE_OBJECTS = new Set([
  "change", "latest", "update", "code", "team", "everyone", "help", "main", "master",
  "branch", "commit", "pr", "feedback", "data", "everything", "file", "work",
]);
/** Dependency nouns that, with an acquisition verb, make install intent explicit. */
const DEP_NOUN_STEMS = new Set(["dependenc", "package", "librar", "lib", "plugin", "sdk"]);

/** First non-determiner word of a token list (the likely head/object). */
function firstObjectWord(words: string[]): string | undefined {
  for (const w of words) if (!OBJECT_DETERMINERS.has(w)) return w;
  return undefined;
}

/** True when a single word is itself a recognized decision-domain keyword. */
function isDomainWord(word: string): boolean {
  return inferDomains(word).size > 0;
}

/** Whether a task expresses dependency-acquisition intent (see block comment above). */
export function dependencyAcquisitionIntent(text: string): boolean {
  const phrase = phraseForm(text); // " add uuid to generate ids "
  const words = phrase.trim().split(" ").filter(Boolean);
  if (words.length === 0) return false;

  // (1) Phrasal acquisition verb ("pull in dayjs") — unless its object is a well-known
  // non-package (VCS/people/generic), the exact place these phrasals innocently appear.
  for (const pv of ACQUIRE_PHRASALS) {
    const at = phrase.indexOf(` ${pv} `);
    if (at === -1) continue;
    const rest = phrase.slice(at + pv.length + 1).trim().split(" ").filter(Boolean);
    const obj = firstObjectWord(rest);
    if (obj && !NON_PACKAGE_OBJECTS.has(stem(obj))) return true;
  }

  // (2) Explicit install vocabulary: the verb "install", or an acquisition verb together
  // with a dependency noun ("add a <library/package/dependency>").
  const tokens = new Set(contentTokens(text));
  if (tokens.has(stem("install"))) return true;
  if (words.some((w) => ACQUIRE_VERBS.has(w)) && [...tokens].some((t) => DEP_NOUN_STEMS.has(t))) {
    return true;
  }

  // (3) Terse "add <bare-name> …": a single-verb acquisition whose immediate object is a
  // bare token (no determiner) that is NOT itself a known decision-domain word (so
  // "add caching / coverage / a button" route to their own domains), followed by a
  // purpose/benefit clause or the end of the request. A following "to/for/as the …"
  // (determiner) is a destination/feature spec, not acquisition, so it does not fire.
  for (let i = 0; i < words.length; i++) {
    if (!ACQUIRE_VERBS.has(words[i]!)) continue;
    const obj = words[i + 1];
    if (!obj || obj.length < 2 || OBJECT_DETERMINERS.has(obj) || isDomainWord(obj)) continue;
    const w2 = words[i + 2];
    if (w2 === undefined) return true; // "Add nanoid." — bare object at end
    if (w2 === "so") return true; // "Add pino so we get structured logs."
    if ((w2 === "to" || w2 === "for" || w2 === "as") && words[i + 3] && !OBJECT_DETERMINERS.has(words[i + 3]!)) {
      return true; // "to generate ids" / "for colored output" — purpose/benefit, not "to the X"
    }
  }
  return false;
}

/** Canonicalize any raw/normalized domain token to its shared canonical form. */
export function canonicalDomain(raw: string): string {
  const n = normalizeDomain(raw);
  return DOMAIN_ALIASES[n] ?? n;
}

/**
 * The RECOMMENDED canonical decision-domain vocabulary (0.4.0).
 *
 * This is deliberately NOT a closed ontology and NOT a validation gate: an agent may
 * record ANY domain (e.g. `robotics-control`) and ctx stores and retrieves it
 * unchanged. The canonical set means one thing only — these are the domains ctx
 * RECOGNIZES for automatic cross-repo surfacing (the task matcher in `analysis.ts`
 * plus the alias/trigger tables above resolve to exactly these tokens). Recording a
 * decision under a canonical domain therefore maximizes cross-agent consistency and
 * the chance ctx surfaces it on a future related task; a custom domain stays valid and
 * retrievable but only surfaces when a task names it explicitly.
 *
 * The set is derived from the classifier's own domains (canonicalized) plus every
 * alias target, so it can never silently drift out of sync — an invariant test
 * (`domains.test.ts`) asserts exactly that. The agent, not ctx core, performs the
 * semantic category selection at write time; ctx only normalizes and classifies.
 */
export const CANONICAL_DOMAINS: ReadonlySet<string> = new Set<string>([
  "package-manager",
  "database",
  "frontend", // the classifier's "ui-framework" canonicalizes here
  "backend", // trigger-only in the classifier; a first-class canonical decision domain
  "state-management",
  "dependency-policy",
  "testing",
  "architecture",
  "error-handling",
  "formatting",
  "infrastructure",
  "response-language",
]);

/** A domain plus whether it is in the recommended canonical vocabulary. */
export interface DomainClassification {
  /** The canonical (alias-resolved) form of the input. */
  domain: string;
  /** True when `domain` is a recognized canonical decision domain (surfaced automatically). */
  canonical: boolean;
}

/**
 * Classify a raw/normalized domain: resolve it to canonical form and report whether
 * that form is in the recommended vocabulary. NEVER rejects — an unknown domain is a
 * valid custom domain (`canonical: false`), preserving forward compatibility.
 */
export function classifyDomain(raw: string): DomainClassification {
  const domain = canonicalDomain(raw);
  return { domain, canonical: CANONICAL_DOMAINS.has(domain) };
}

/** Whether a raw/normalized domain resolves to a recognized canonical decision domain. */
export function isCanonicalDomain(raw: string): boolean {
  return CANONICAL_DOMAINS.has(canonicalDomain(raw));
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
  // Dependency-acquisition tasks ("add uuid", "pull in dayjs") implicate the
  // package-manager decision even when they name no package manager (F3). Additive and
  // deterministic — see `dependencyAcquisitionIntent`.
  if (dependencyAcquisitionIntent(text)) out.add("package-manager");
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
