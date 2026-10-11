/**
 * Deterministic MOCK agent — a HARNESS SELF-TEST FIXTURE, not a model (spec §53, §29).
 *
 * It exists so the whole pipeline (conditions → isolation → ctx delivery → scoring →
 * persistence → resume → stats) can be exercised offline and deterministically, with no
 * API calls. It must never appear in a published RESULT: results come only from real
 * agent adapters. It is labeled `mock` in every record so that is unambiguous.
 *
 * Its one honest simulation: an agent's adherence is a function of whether the preference
 * is VISIBLE in its context at probe time. It models a bounded context window — distant
 * prior turns fall out of recency — while `injectedContext` (what ctx delivers) is always
 * visible. So heavy interference makes the control "forget" and default, exactly the
 * dynamic the benchmark measures. The preference→behavior knowledge below is generic
 * (not keyed to any scenario id); preferences it does not understand yield `unsupported`.
 */
import type { ObservedBehavior } from "../schema.ts";
import type { AgentAdapter, AgentRunRequest, AgentRunResult } from "./types.ts";

/** Recency budget (chars) of prior conversation the mock still "sees" at probe time. */
const CONTEXT_WINDOW_CHARS = 1500;

interface Rival {
  /** The distinctive token this behavior is detected by (e.g. "bun"). */
  token: string;
  /** Regexes over preference text that select this behavior. */
  prefCues: RegExp[];
  /** Produce the behavior for a given action payload. */
  emit: (action: Action) => ObservedBehavior;
}

interface Dimension {
  /** Which probe actions this dimension responds to. */
  appliesTo: (a: Action) => boolean;
  /** The option the agent falls back to with NO preference in context. */
  fallback: Rival;
  /** Preference-selected options (checked before fallback). */
  options: Rival[];
}

type Action =
  | { kind: "add-dep"; pkg: string }
  | { kind: "tests" }
  | { kind: "script" }
  | { kind: "db" }
  | { kind: "unknown" };

function detectAction(probe: string): Action {
  const p = probe.toLowerCase();
  // Order matters: tests/db/script are checked BEFORE add-dep so a probe like
  // "Add tests…" or "Add a store…" is not mistaken for installing a package named
  // "tests"/"store". add-dep is the last resort and requires a real package token.
  if (/\b(test|tests|spec|coverage|safety net)\b/.test(p)) return { kind: "tests" };
  if (/\b(database|persist|persistence|datastore|data store|schema|\bdb\b|store|records?)\b/.test(p)) return { kind: "db" };
  if (/\b(script|parse|parses|cli|utility)\b/.test(p)) return { kind: "script" };
  const dep = /\b(?:add|install|bring in|pull in)\s+(?:the\s+)?([a-z0-9@._/-]{2,})/.exec(p);
  if (dep) return { kind: "add-dep", pkg: sanitizePkg(dep[1]!) };
  return { kind: "unknown" };
}

function sanitizePkg(raw: string): string {
  const known = ["zod", "lodash", "dayjs", "axios", "express", "chalk", "commander", "uuid", "pino"];
  const hit = known.find((k) => raw.includes(k));
  return hit ?? (raw.replace(/[^a-z0-9@._/-]/gi, "") || "zod");
}

// --- generic preference knowledge (NOT scenario-specific) ------------------
const DIMENSIONS: Dimension[] = [
  {
    // package manager
    appliesTo: (a) => a.kind === "add-dep",
    fallback: {
      token: "npm",
      prefCues: [/\bnpm\b/i],
      emit: (a) => ({ commands: [`npm install ${pkg(a)}`], files: {}, finalText: "" }),
    },
    options: [
      { token: "bun", prefCues: [/\bbun\b/i], emit: (a) => ({ commands: [`bun add ${pkg(a)}`], files: {}, finalText: "" }) },
      { token: "pnpm", prefCues: [/\bpnpm\b/i], emit: (a) => ({ commands: [`pnpm add ${pkg(a)}`], files: {}, finalText: "" }) },
      { token: "yarn", prefCues: [/\byarn\b/i], emit: (a) => ({ commands: [`yarn add ${pkg(a)}`], files: {}, finalText: "" }) },
    ],
  },
  {
    // test framework
    appliesTo: (a) => a.kind === "tests",
    fallback: {
      token: "jest",
      prefCues: [/\bjest\b/i],
      emit: () => ({ commands: ["jest"], files: { "src/parser.test.ts": "import { it, expect } from '@jest/globals';\n" }, finalText: "" }),
    },
    options: [
      {
        token: "vitest",
        prefCues: [/\bvitest\b/i],
        emit: () => ({ commands: ["vitest run"], files: { "src/parser.test.ts": "import { it, expect } from 'vitest';\n" }, finalText: "" }),
      },
    ],
  },
  {
    // language of a quick script/utility
    appliesTo: (a) => a.kind === "script",
    fallback: {
      token: "javascript",
      prefCues: [/\bjavascript\b/i, /\.js\b/i],
      emit: () => ({ commands: [], files: { "scripts/task.js": "// generated\nmodule.exports = {};\n" }, finalText: "" }),
    },
    options: [
      {
        token: "typescript",
        prefCues: [/\btypescript\b/i, /\.ts\b/i],
        emit: () => ({ commands: [], files: { "scripts/task.ts": "// generated\nexport {};\n" }, finalText: "" }),
      },
    ],
  },
  {
    // database
    appliesTo: (a) => a.kind === "db",
    fallback: {
      token: "mysql",
      prefCues: [/\bmysql\b/i],
      emit: () => ({ commands: ["npm install mysql2"], files: { "src/db.ts": "import mysql from 'mysql2';\n" }, finalText: "" }),
    },
    options: [
      { token: "postgres", prefCues: [/\bpostgres(ql)?\b/i, /\bpg\b/i], emit: () => ({ commands: ["npm install pg"], files: { "src/db.ts": "import { Client } from 'pg';\n" }, finalText: "" }) },
      { token: "sqlite", prefCues: [/\bsqlite\b/i], emit: () => ({ commands: ["npm install better-sqlite3"], files: { "src/db.ts": "import Database from 'better-sqlite3';\nconst db = new Database(':memory:');\n" }, finalText: "" }) },
    ],
  },
];

function pkg(a: Action): string {
  return a.kind === "add-dep" ? a.pkg : "zod";
}

/**
 * Pick the preferred option whose cue appears LATEST in the agent's visible context
 * (recency wins — this is how a correction/reversal is honored). `injectedContext` is
 * treated as the most-recent, highest-priority text (it arrives at probe time).
 */
function pickOption(dim: Dimension, visible: string): Rival | null {
  let best: { rival: Rival; at: number } | null = null;
  // Options and the fallback compete purely on recency of a NON-negated mention, so a
  // single rule like "use Bun instead of npm" counts Bun (a directive) and ignores npm
  // (a rejection), while "for this task use npm" counts npm (a directive).
  for (const rival of [...dim.options, dim.fallback]) {
    for (const cue of rival.prefCues) {
      const m = lastDirectiveIndex(visible, cue);
      if (m >= 0 && (!best || m > best.at)) best = { rival, at: m };
    }
  }
  return best?.rival ?? null;
}

/** "use/switch/prefer X" is a directive; "instead of/rather than/not/over X" is a rejection. */
const NEGATION_BEFORE = /\b(instead of|rather than|over|no longer|not|never use|avoid|don'?t use|dont use|moving off|away from)\s+$/i;

function lastDirectiveIndex(text: string, re: RegExp): number {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let last = -1;
  for (const m of text.matchAll(g)) {
    const idx = m.index ?? -1;
    if (idx < 0) continue;
    const before = text.slice(Math.max(0, idx - 20), idx);
    if (NEGATION_BEFORE.test(before)) continue; // negated mention → not a directive
    last = idx;
  }
  return last;
}

export class MockAgent implements AgentAdapter {
  readonly id = "mock";
  readonly capabilities = { freshSession: true, compaction: true };
  version(): string {
    return "mock-1";
  }
  available(): boolean {
    return true;
  }

  run(req: AgentRunRequest): Promise<AgentRunResult> {
    const action = detectAction(req.probe);
    const dim = DIMENSIONS.find((d) => d.appliesTo(action));
    if (!dim) return Promise.resolve({ behavior: empty(), supported: false });

    // Visible context, oldest → most-recent: recency-trimmed prior turns, then the
    // ctx-injected block, then the probe itself. `pickOption` takes the LAST cue, so an
    // explicit instruction in the current probe ("for this task, use npm") overrides a
    // durable preference — exactly the precedence the brief tests (spec §19).
    const priorJoined = req.freshSession ? "" : req.priorTurns.join("\n");
    const visiblePrior = priorJoined.slice(Math.max(0, priorJoined.length - CONTEXT_WINDOW_CHARS));
    const visible = `${visiblePrior}\n${req.injectedContext}\n${req.probe}`;

    const chosen = pickOption(dim, visible) ?? dim.fallback;
    return Promise.resolve({ behavior: chosen.emit(action), supported: true });
  }
}

function empty(): ObservedBehavior {
  return { commands: [], files: {}, finalText: "" };
}
