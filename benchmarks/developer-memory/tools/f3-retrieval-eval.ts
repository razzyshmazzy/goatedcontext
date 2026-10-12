/**
 * F3 DETERMINISTIC RETRIEVAL EVAL (no model calls).
 *
 * Measures retrieval DELIVERY recall + false-positive rate for the F3 class
 * (oblique / terse dependency + implicit-domain tasks) by driving the REAL ctx
 * pipeline through `ctx test-hook --json` in an isolated CTX_HOME. For each case it
 * also prints WHY via the exported analysis functions (inferred task domains vs the
 * stored preference's domain). Pure/deterministic — spawns `bun src/index.ts`, never a
 * model. Cases are derived from the DEV split + synthetic probes only; the v1.1
 * held-out probes are never reused verbatim.
 *
 *   bun run benchmarks/developer-memory/tools/f3-retrieval-eval.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { inferDomains } from "../../../src/core/preferences/analysis.ts";
import { collectDomainsFromText, canonicalDomain } from "../../../src/core/signals/domains.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const IDX = join(HERE, "..", "..", "..", "src", "index.ts");

type Scope = "global" | "repo";
interface Pref { text: string; scope: Scope }
interface Case {
  id: string;
  group: string;
  prefs: Pref[];
  /** The preference text whose delivery we require/forbid. */
  target: string;
  /** Canonical domain the target preference belongs to (for the WHY table). */
  targetDomain: string;
  task: string;
  /** true = target SHOULD be delivered (recall); false = must NOT be (false positive). */
  expect: boolean;
}

const PM = "package-manager";
const DB = "database";
const TEST = "testing";

// Package-manager preferences kept in `relevant` applicability (none start with a
// universal "always …" leader), so they are scored — exactly the F3 path.
const pnpmRepo: Pref = { text: "In this repo we use pnpm for everything.", scope: "repo" };
const bunGlobal: Pref = { text: "Use Bun for package management, never npm.", scope: "global" };
const yarnGlobal: Pref = { text: "This machine is set up for Yarn — stick to it for packages.", scope: "global" };
const pnpmGlobal: Pref = { text: "My package manager of choice is pnpm.", scope: "global" };
const vitestGlobal: Pref = { text: "I like Vitest for testing.", scope: "global" };
const pgGlobal: Pref = { text: "Relational data goes in Postgres for me.", scope: "global" };

const cases: Case[] = [
  // ---- GROUP A: package-manager install intent (POSITIVES) ----------------
  { id: "A1-add-uuid", group: "pm-install", prefs: [pnpmRepo], target: pnpmRepo.text, targetDomain: PM,
    task: "Add uuid to generate ids.", expect: true }, // dev repo-pnpm-add-uuid probe
  { id: "A2-pull-dayjs", group: "pm-install", prefs: [bunGlobal], target: bunGlobal.text, targetDomain: PM,
    task: "Pull in dayjs so we can format timestamps.", expect: true }, // dev bun-add-dayjs-heavy probe
  { id: "A3-bring-ramda", group: "pm-install", prefs: [pnpmGlobal], target: pnpmGlobal.text, targetDomain: PM,
    task: "Bring in ramda for the helpers.", expect: true },
  { id: "A4-install-redis", group: "pm-install", prefs: [bunGlobal], target: bunGlobal.text, targetDomain: PM,
    task: "Install the redis client.", expect: true },
  { id: "A5-add-zod-lib", group: "pm-install", prefs: [pnpmGlobal], target: pnpmGlobal.text, targetDomain: PM,
    task: "Add the zod library.", expect: true },
  { id: "A6-depend-commander", group: "pm-install", prefs: [yarnGlobal], target: yarnGlobal.text, targetDomain: PM,
    task: "Depend on commander for the CLI.", expect: true },
  { id: "A7-add-dep-generic", group: "pm-install", prefs: [pnpmGlobal], target: pnpmGlobal.text, targetDomain: PM,
    task: "Add a dependency for parsing CSV.", expect: true },
  { id: "A8-need-handling-bring", group: "pm-install", prefs: [bunGlobal], target: bunGlobal.text, targetDomain: PM,
    task: "We need date handling — bring in luxon.", expect: true }, // shape of dev implicit-bun-scaffold
  { id: "A9-add-nanoid-terse", group: "pm-install", prefs: [pnpmRepo], target: pnpmRepo.text, targetDomain: PM,
    task: "Add nanoid.", expect: true }, // tersest form: bare pkg, end of clause

  // ---- GROUP A negatives: same PM pref, NOT a dependency install ----------
  { id: "A-neg-button", group: "pm-neg", prefs: [pnpmRepo], target: pnpmRepo.text, targetDomain: PM,
    task: "Add a button to the settings page.", expect: false },
  { id: "A-neg-retry", group: "pm-neg", prefs: [bunGlobal], target: bunGlobal.text, targetDomain: PM,
    task: "Add a retry around the fetch call.", expect: false },
  { id: "A-neg-rename", group: "pm-neg", prefs: [pnpmGlobal], target: pnpmGlobal.text, targetDomain: PM,
    task: "Rename the greeting constant to salutation.", expect: false },
  { id: "A-neg-tcp", group: "pm-neg", prefs: [bunGlobal], target: bunGlobal.text, targetDomain: PM,
    task: "Explain how TCP slow start works.", expect: false },
  { id: "A-neg-endpoint", group: "pm-neg", prefs: [pnpmGlobal], target: pnpmGlobal.text, targetDomain: PM,
    task: "Add an endpoint that returns the current user.", expect: false },
  { id: "A-neg-log", group: "pm-neg", prefs: [bunGlobal], target: bunGlobal.text, targetDomain: PM,
    task: "Add logging to the request handler.", expect: false },
  { id: "A-neg-caching", group: "pm-neg", prefs: [bunGlobal], target: bunGlobal.text, targetDomain: PM,
    task: "Add caching to speed up the dashboard.", expect: false }, // "to"+verb shape, but object is a concept
  { id: "A-neg-pull-main", group: "pm-neg", prefs: [pnpmGlobal], target: pnpmGlobal.text, targetDomain: PM,
    task: "Pull in the latest changes from main.", expect: false }, // phrasal verb, VCS object (not a package)
  { id: "A-neg-validation-for", group: "pm-neg", prefs: [pnpmRepo], target: pnpmRepo.text, targetDomain: PM,
    task: "Add validation for the signup form.", expect: false }, // "add X for Y" structural distractor

  // ---- GROUP B: testing implicit (POSITIVES) ------------------------------
  { id: "B1-add-tests", group: "test-pos", prefs: [vitestGlobal], target: vitestGlobal.text, targetDomain: TEST,
    task: "Add tests for the parser module.", expect: true },
  { id: "B2-no-tests-yet", group: "test-pos", prefs: [vitestGlobal], target: vitestGlobal.text, targetDomain: TEST,
    task: "The auth module has no tests yet. Add some.", expect: true },
  { id: "B3-coverage", group: "test-pos", prefs: [vitestGlobal], target: vitestGlobal.text, targetDomain: TEST,
    task: "Write some coverage for the new serializer.", expect: true },

  // ---- GROUP B negatives --------------------------------------------------
  { id: "B-neg-validation", group: "test-neg", prefs: [vitestGlobal], target: vitestGlobal.text, targetDomain: TEST,
    task: "Add parser validation for malformed input.", expect: false },
  { id: "B-neg-css", group: "test-neg", prefs: [vitestGlobal], target: vitestGlobal.text, targetDomain: TEST,
    task: "Refactor the CSS in the header.", expect: false },

  // ---- GROUP C: database implicit (POSITIVES) -----------------------------
  { id: "C1-persistence", group: "db-pos", prefs: [pgGlobal], target: pgGlobal.text, targetDomain: DB,
    task: "Set up persistence for production.", expect: true },
  { id: "C2-store-records", group: "db-pos", prefs: [pgGlobal], target: pgGlobal.text, targetDomain: DB,
    task: "Where should we store user records so they persist across restarts?", expect: true },
  { id: "C3-schema", group: "db-pos", prefs: [pgGlobal], target: pgGlobal.text, targetDomain: DB,
    task: "Design the schema for orders and line items.", expect: true },

  // ---- GROUP C negatives --------------------------------------------------
  { id: "C-neg-envvar", group: "db-neg", prefs: [pgGlobal], target: pgGlobal.text, targetDomain: DB,
    task: "Store the API key in an environment variable.", expect: false },
  { id: "C-neg-ui-table", group: "db-neg", prefs: [pgGlobal], target: pgGlobal.text, targetDomain: DB,
    task: "Add a loading spinner to the orders list.", expect: false },
];

interface HookResult {
  runtimeContext: { domain: string | null };
  preferences: { rule: string; domain: string | null; relevance: number }[];
  plan: { static: { rule: string }[]; runtime: { rule: string }[] };
}

function run(args: string[], cwd: string, ctxHome: string, stdin?: string) {
  return spawnSync("bun", [IDX, ...args], {
    cwd, env: { ...process.env, CTX_HOME: ctxHome }, input: stdin, encoding: "utf8", timeout: 30_000,
  });
}

function prepare(prefs: Pref[]): { cwd: string; ctxHome: string } {
  const ctxHome = mkdtempSync(join(tmpdir(), "f3-ctx-"));
  const cwd = mkdtempSync(join(tmpdir(), "f3-wd-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "f3", version: "1.0.0" }));
  if (prefs.some((p) => p.scope === "repo")) {
    run(["--version"], cwd, ctxHome); // no-op warmup
    spawnSync("git", ["init", "-q"], { cwd });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd });
    spawnSync("git", ["config", "user.name", "t"], { cwd });
    spawnSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd, env: { ...process.env } });
  }
  for (const p of prefs) {
    const r = run(["agent", "remember", p.text, "--origin", "user", "--scope", p.scope, "--agent-id", "ctxbench"], cwd, ctxHome);
    if (r.status !== 0) throw new Error(`remember failed (${p.scope}): ${r.stderr || r.stdout}`);
  }
  return { cwd, ctxHome };
}

function delivered(c: Case): { hit: boolean; domain: string | null; rel: number | null } {
  const { cwd, ctxHome } = prepare(c.prefs);
  const r = run(["test-hook", "--agent", "claude", "--cwd", cwd, "--task", c.task, "--json"], cwd, ctxHome);
  if (r.status !== 0) throw new Error(`test-hook failed: ${r.stderr || r.stdout}`);
  const j = JSON.parse(r.stdout) as HookResult;
  // DELIVERY = the task-scored, relevance-filtered set the agent actually receives for
  // THIS task (`result.preferences` → the rendered context block). `plan.static/runtime`
  // is the standing per-pref channel map (all active rules) and is NOT task-filtered.
  const match = j.preferences.find((p) => p.rule.trim() === c.target.trim());
  return { hit: match != null, domain: j.runtimeContext.domain, rel: match ? match.relevance : null };
}

function whyDomains(task: string): string {
  const cls = [...inferDomains(task)].map(canonicalDomain);
  const canon = [...collectDomainsFromText(task)];
  const union = [...new Set([...cls, ...canon])].sort();
  return union.length ? union.join(",") : "∅";
}

// ---- run -------------------------------------------------------------------
let posTotal = 0, posHit = 0, negTotal = 0, negFire = 0;
const rows: string[] = [];
rows.push(["case", "exp", "deliv", "taskDomains", "prefDom", "rel", "verdict"].join("\t"));
for (const c of cases) {
  const { hit, rel } = delivered(c);
  const domains = whyDomains(c.task);
  if (c.expect) { posTotal++; if (hit) posHit++; }
  else { negTotal++; if (hit) negFire++; }
  const ok = hit === c.expect;
  rows.push([
    c.id, c.expect ? "HIT" : "no", hit ? "yes" : "MISS",
    domains, c.targetDomain, rel == null ? "-" : rel.toFixed(2),
    ok ? "ok" : (c.expect ? "**RECALL-MISS**" : "**FALSE-POS**"),
  ].join("\t"));
}

console.log(rows.join("\n"));
console.log("\n=== F3 deterministic retrieval eval ===");
console.log(`cases: ${cases.length}  (positives ${posTotal}, negatives ${negTotal})`);
console.log(`delivery recall:     ${posHit}/${posTotal} = ${(100 * posHit / posTotal).toFixed(1)}%`);
console.log(`false-positive rate: ${negFire}/${negTotal} = ${(100 * negFire / negTotal).toFixed(1)}%`);
const prec = posHit + negFire > 0 ? posHit / (posHit + negFire) : NaN;
console.log(`precision:           ${(100 * prec).toFixed(1)}%`);
