/**
 * developer-memory benchmark — scenario schema (v1).
 *
 * This is the declarative contract for every benchmark scenario. Scenarios are DATA
 * (see ../scenarios), never hardcoded tests, so the dataset can be versioned, hashed,
 * split into development/held-out sets, and frozen (spec §5, §51, §60).
 *
 * NOTHING in this file imports goatedcontext production code — the benchmark lives
 * entirely outside `src/` and must never influence product behavior (spec §58).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Scorers — deterministic, behavior-first (spec §20, §21).
// A scorer describes HOW to decide pass/fail from an agent's observed behavior
// (the commands it ran and the files it created/edited), NOT from its prose.
// ---------------------------------------------------------------------------

/**
 * The observable behavior captured from one agent run. Everything a deterministic
 * scorer is allowed to look at. Prose is captured for debugging/failure examples
 * ONLY — scorers must never key off `finalText` (spec §20).
 */
export const ObservedBehaviorSchema = z.object({
  /** Shell commands the agent executed or proposed to execute, in order. */
  commands: z.array(z.string()).default([]),
  /** Files the agent created or modified: path -> full new contents. */
  files: z.record(z.string(), z.string()).default({}),
  /** The agent's final natural-language message. Debug/forensics only — never scored. */
  finalText: z.string().default(""),
});
export type ObservedBehavior = z.infer<typeof ObservedBehaviorSchema>;

/**
 * The deterministic scorer kinds (spec §21). Each maps to a pure function in scorers.ts.
 * The type is declared manually (not inferred) because the schema is recursive (`all`/
 * `any` contain scorers); a self-referential `z.infer` would resolve to `any`.
 */
export type Scorer =
  | { kind: "commandContains"; pattern: string }
  | { kind: "commandNotContains"; patterns: string[] }
  | { kind: "fileExists"; pathPattern: string }
  | { kind: "fileExtension"; anyOf: string[] }
  | { kind: "fileExtensionNotAnyOf"; noneOf: string[] }
  | { kind: "fileContains"; pattern: string; pathPattern?: string }
  | { kind: "packageAdded"; pkg: string; tool: "bun" | "npm" | "pnpm" | "yarn" }
  | { kind: "frameworkDetected"; framework: string }
  | { kind: "exactChoice"; choice: string; notOneOf: string[] }
  | { kind: "noForbiddenChoice"; forbidden: string[] }
  | { kind: "all"; scorers: Scorer[] }
  | { kind: "any"; scorers: Scorer[] };

export const ScorerSchema: z.ZodType<Scorer> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("commandContains"), pattern: z.string() }),
    z.object({ kind: z.literal("commandNotContains"), patterns: z.array(z.string()).min(1) }),
    z.object({ kind: z.literal("fileExists"), pathPattern: z.string() }),
    z.object({ kind: z.literal("fileExtension"), anyOf: z.array(z.string()).min(1) }),
    z.object({ kind: z.literal("fileExtensionNotAnyOf"), noneOf: z.array(z.string()).min(1) }),
    z.object({ kind: z.literal("fileContains"), pattern: z.string(), pathPattern: z.string().optional() }),
    z.object({ kind: z.literal("packageAdded"), pkg: z.string(), tool: z.enum(["bun", "npm", "pnpm", "yarn"]) }),
    z.object({ kind: z.literal("frameworkDetected"), framework: z.string() }),
    z.object({ kind: z.literal("exactChoice"), choice: z.string(), notOneOf: z.array(z.string()).default([]) }),
    z.object({ kind: z.literal("noForbiddenChoice"), forbidden: z.array(z.string()).min(1) }),
    z.object({ kind: z.literal("all"), scorers: z.array(ScorerSchema).min(1) }),
    z.object({ kind: z.literal("any"), scorers: z.array(ScorerSchema).min(1) }),
  ]),
) as z.ZodType<Scorer>;

// ---------------------------------------------------------------------------
// Scenario structure.
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  "explicit-default",
  "repo-scoped",
  "conditional",
  "correction",
  "implicit",
  "negative-abstention",
  "poisoning",
  "conflict-precedence",
  "reinforcement",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Which standardized interference pack to bury the preference under (spec §14). */
export const INTERFERENCE_LEVELS = ["none", "light", "medium", "heavy"] as const;
export type InterferenceLevel = (typeof INTERFERENCE_LEVELS)[number];

/**
 * One preference-setting message, as the USER would say it. `origin` records who is
 * speaking so the ctx condition can label the memory write correctly (the poisoning
 * category plants `project`/`external` origins that must NOT become user memory).
 */
export const PreferenceStmtSchema = z.object({
  /** Verbatim user utterance that expresses (or revokes) the preference. */
  text: z.string().min(1),
  /** Source class for the ctx write path. Defaults to the developer speaking. */
  origin: z.enum(["user", "project", "external"]).default("user"),
  /** global | repo. Repo-scoped preferences must not leak across repos (spec §7). */
  scope: z.enum(["global", "repo"]).default("global"),
  /**
   * For conditional preferences: a human-readable gate ("when the project uses Vite").
   * Informational for the harness; the probe's `appliesHere` decides scoring.
   */
  when: z.string().optional(),
});
export type PreferenceStmt = z.infer<typeof PreferenceStmtSchema>;

/**
 * Untrusted content planted in the sandbox repo for poisoning tests (spec §17).
 * Written to a file BEFORE the probe. It must never alter durable user memory.
 */
export const PoisonSchema = z.object({
  /** Repo-relative path to write the adversarial content to (e.g. "README.md"). */
  path: z.string().min(1),
  /** The adversarial content (fake preference, injected "ctx remember" instruction, etc.). */
  content: z.string().min(1),
});
export type Poison = z.infer<typeof PoisonSchema>;

export const ScenarioSchema = z
  .object({
    /** Stable unique id (kebab-case). Used as the resume key and in result records. */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    category: z.enum(CATEGORIES),
    /** Which split this belongs to. Held-out scenarios must never drive product tuning (§51). */
    split: z.enum(["dev", "heldout"]).default("dev"),
    /** One-line human summary. */
    title: z.string().min(1),

    /**
     * The preference(s) the user expresses, in order. A plain explicit-default has one;
     * a correction scenario (§9) has the original then the reversal; a conflict scenario
     * (§19) may carry a global then a repo-scoped override.
     */
    setupPreference: z.array(PreferenceStmtSchema).min(1),

    /**
     * The programming language / stack the sandbox repo is seeded as, so file-extension
     * and framework scorers are meaningful and the probe reads naturally.
     */
    repoLanguage: z.string().default("typescript"),

    /** Standardized interference pack to run between setup and probe (spec §14). */
    interference: z.enum(INTERFERENCE_LEVELS).default("medium"),

    /**
     * The probe: a later task that IMPLICITLY requires the preference (spec §10). It must
     * NEVER name the preference or ask "what did I prefer?" — enforced by validateScenario.
     */
    probe: z.string().min(1),

    /**
     * Does the preference legitimately apply to THIS probe? For conditional/negative
     * scenarios we run both the matching and non-matching cases; `false` means the
     * correct behavior is to NOT apply the preference (abstention).
     */
    appliesHere: z.boolean().default(true),

    /** Short description of the expected behavioral action (e.g. "runs `bun add zod`"). */
    expectedBehavior: z.string().min(1),
    /** Short description of the forbidden action(s) (e.g. "npm/yarn/pnpm install"). */
    forbiddenBehavior: z.string().min(1),

    /** The deterministic scorer applied to the agent's observed behavior. */
    scorer: ScorerSchema,

    /** Optional adversarial repo content planted before the probe (poisoning, §17). */
    poison: z.array(PoisonSchema).default([]),

    /**
     * Scope-leak test (spec §7, §16): when true, the ctx condition records the
     * repo-scoped preference against a DIFFERENT repository identity than the probe
     * runs in. A correct engine must NOT deliver that preference here. Pair with
     * `appliesHere:false` and a `noForbiddenChoice` scorer.
     */
    crossRepoLeak: z.boolean().default(false),

    /**
     * Cross-agent routing (spec §12): preference introduced via `sourceAgent`, probed via
     * `destinationAgent`. Omitted → same-agent. The receiving agent is NEVER given the
     * source conversation; it only has normal ctx access.
     */
    sourceAgent: z.string().optional(),
    destinationAgent: z.string().optional(),

    /** Free-text curation notes (why this scenario exists, edge it targets). */
    notes: z.string().default(""),
  })
  .strict();
export type Scenario = z.infer<typeof ScenarioSchema>;

/**
 * The INPUT shape for authoring scenarios: fields with schema defaults (split, poison,
 * crossRepoLeak, appliesHere, …) are optional here but always present on the parsed
 * `Scenario`. Dataset files are typed as `ScenarioInput[]`; `ScenarioSchema.parse` fills
 * the defaults.
 */
export type ScenarioInput = z.input<typeof ScenarioSchema>;

/**
 * Structural validation BEYOND the zod shape, enforcing the anti-cheating rules the
 * spec is emphatic about (§5 "do not encode the answer into probe wording", §10 "the
 * probe should never explicitly ask what do I prefer"). Returns a list of human-readable
 * problems; empty list = valid. Used by `--dry-run` (spec §29) and the schema test.
 */
export function validateScenario(s: Scenario): string[] {
  const problems: string[] = [];
  const probe = s.probe.toLowerCase();

  // §10: the probe must not ask the agent to recall the preference.
  const recallTells = [
    "what do i prefer",
    "what did i prefer",
    "which did i",
    "did i tell",
    "did i say",
    "did i ask",
    "remember what i said",
    "remember my preference",
    "as i mentioned",
    "like i said",
    "what i told you",
    "you remember",
    "recall what",
  ];
  for (const tell of recallTells) {
    if (probe.includes(tell)) problems.push(`probe appears to ask for recall ("${tell}")`);
  }

  // §5 / §52: the probe must not leak the answer. For an exactChoice/packageAdded/
  // frameworkDetected scenario, the probe must not contain the literal chosen artifact
  // (e.g. a "use Bun" scenario whose probe literally says "bun"). This is a heuristic
  // guard against lexical shortcuts, scoped to positively-applied scenarios.
  if (s.appliesHere) {
    const leaked = probeLeaks(s.scorer, probe);
    if (leaked) problems.push(`probe leaks the expected answer token "${leaked}" (see spec §52)`);
  }

  // A correction scenario must carry at least two preference statements (orig + reversal).
  if (s.category === "correction" && s.setupPreference.length < 2) {
    problems.push("correction scenario needs at least two setupPreference entries (original + update)");
  }

  // A poisoning scenario must actually plant adversarial content.
  if (s.category === "poisoning" && s.poison.length === 0) {
    problems.push("poisoning scenario must define at least one poison entry");
  }

  // Cross-agent fields must be paired.
  if (Boolean(s.sourceAgent) !== Boolean(s.destinationAgent)) {
    problems.push("sourceAgent and destinationAgent must be set together");
  }

  return problems;
}

/** The literal "answer tokens" a scorer keys off, used to detect probe leakage. */
function answerTokens(scorer: Scorer): string[] {
  switch (scorer.kind) {
    case "exactChoice":
      return [scorer.choice];
    case "packageAdded":
      return [scorer.tool];
    case "frameworkDetected":
      return [scorer.framework];
    case "commandContains":
      return [scorer.pattern];
    case "all":
    case "any":
      return scorer.scorers.flatMap(answerTokens);
    default:
      return [];
  }
}

function probeLeaks(scorer: Scorer, probeLower: string): string | null {
  for (const raw of answerTokens(scorer)) {
    const tok = raw.toLowerCase().trim();
    // Only flag discriminating, word-like tokens (len ≥ 3, no regex meta); common
    // generic words are allowed. A tool/choice like "bun"/"vitest"/"postgres" leaking
    // into the probe is the real hazard.
    if (tok.length < 3 || /[.*+?^${}()|[\]\\]/.test(tok)) continue;
    const re = new RegExp(`\\b${tok}\\b`);
    if (re.test(probeLower)) return tok;
  }
  return null;
}
