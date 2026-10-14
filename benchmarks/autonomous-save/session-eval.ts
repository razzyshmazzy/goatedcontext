/**
 * Autonomous-memory accumulation eval CLI.
 *
 *   bun run benchmarks/autonomous-save/session-eval.ts plan            # cost guard only
 *   bun run benchmarks/autonomous-save/session-eval.ts validate        # 1 cheap mini-session (harness check)
 *   CTXBENCH_ENABLE_CLAUDE=1 CTXBENCH_MODEL=claude-sonnet-4-6 \
 *     bun run benchmarks/autonomous-save/session-eval.ts run           # Sessions A + B (2 invocations)
 *
 * Scores ACTUAL ctx state after each turn + final (never prose). Hard cap 8 invocations.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS, expectedDurable, expectedSignals, expectedNothing, type Session } from "./sessions.ts";
import { runSession, claudeVersion, type SessionRun, type TurnResult } from "./session-runner.ts";

const HARD_CAP = 8;
const log = (s = "") => process.stdout.write(s + "\n");
const lc = (s: string) => s.toLowerCase();
const frac = (num: number, den: number) => (den === 0 ? `${num}/${den} (n/a)` : `${num}/${den} (${((num / den) * 100).toFixed(0)}%)`);

function printPlan(n: number, model: string | null) {
  log("== Cost guard ==");
  log(`  planned sessions     : 2 (A: pnpm/vitest/temp, B: db/arch/correction)`);
  log(`  planned invocations  : ${n} (one continuing streaming session each)`);
  log(`  model                : ${model ?? "(unset)"}`);
  log(`  claude binary        : ${claudeVersion() ?? "(unavailable)"}`);
  log(`  hard cap             : ${HARD_CAP}`);
  log(`  est. cost            : ~$0.50–2.00 per ~12-turn accumulating session → ~$${(n * 1.2).toFixed(2)} (exact post-run)`);
}

// ── Scoring ──────────────────────────────────────────────────────────────────
interface Metrics {
  durablePrefRecall: [number, number];
  durablePrefPrecision: [number, number];
  signalRecall: [number, number];
  ignorePrecision: [number, number];
  tempOverrideSafety: [number, number];
  provenanceSafety: [number, number];
  duplicateWrites: number;
  selfFeedbackWrites: number;
  scopeAccuracy: [number, number];
  conditionalAccuracy: [number, number];
  overSaveRate: [number, number];
  safeSurface: [number, number];
  recoveredBareAttempts: number;
  barePersisted: number;
  expectedDurable: number;
  actualDurable: number;
  expectedSignals: number;
  actualSignals: number;
  unnecessary: number;
  missed: number;
  failures: string[];
}

const prefHas = (run: SessionRun, needles: string[], scope?: string) =>
  run.finalState.prefs.some((p) => (!scope || p.scope === scope) && needles.some((n) => lc(p.rule).includes(lc(n))));

/** New durable writes observed across the session (turns whose snapshot grew prefs). */
function perTurnWrites(run: SessionRun): Array<{ t: TurnResult; newPrefs: number; newSignals: number }> {
  const out: Array<{ t: TurnResult; newPrefs: number; newSignals: number }> = [];
  let prevP = 0;
  let prevS = 0;
  for (const t of run.turns) {
    const p = t.state.prefs.length;
    const s = t.state.signalDomains.reduce((a, d) => a + d.choices.length, 0);
    out.push({ t, newPrefs: p - prevP, newSignals: s - prevS });
    prevP = p;
    prevS = s;
  }
  return out;
}

function scoreSession(session: Session, run: SessionRun): Metrics {
  const failures: string[] = [];
  const writes = perTurnWrites(run);
  const durableTurns = expectedDurable(session);
  const signalTurns = expectedSignals(session);
  const nothingTurns = expectedNothing(session);

  // Durable preference recall: each remember/correction turn's target present in final state.
  let drN = 0;
  for (const t of durableTurns) {
    if (t.wants && prefHas(run, t.wants, t.scope)) drN++;
    else failures.push(`missed_preference@turn${t.n} (${t.kind}): "${t.user}"`);
  }

  // Scope accuracy among durable prefs that have an expected scope.
  let scN = 0;
  let scD = 0;
  for (const t of durableTurns) {
    if (!t.scope || !t.wants) continue;
    scD++;
    if (run.finalState.prefs.some((p) => p.scope === t.scope && t.wants!.some((n) => lc(p.rule).includes(lc(n))))) scN++;
    else failures.push(`wrong_scope@turn${t.n}: want ${t.scope} for ${t.wants.join("/")}`);
  }

  // Conditional accuracy (Session B turn 9): both sqlite+postgres captured with the condition.
  let condN = 0;
  let condD = 0;
  for (const t of durableTurns.filter((x) => x.kind === "correction")) {
    condD++;
    const hasSqlite = prefHas(run, ["sqlite"]);
    const hasPg = prefHas(run, ["postgres"]);
    const conditional = run.finalState.prefs.some((p) => /prototype|production|when|for /i.test(p.rule) && /sqlite|postgres/i.test(p.rule));
    if (hasSqlite && hasPg && conditional) condN++;
    else failures.push(`conditional_imprecise@turn${t.n}: sqlite=${hasSqlite} pg=${hasPg} conditional=${conditional}`);
  }

  // Signal recall.
  let sigN = 0;
  const allSignalChoices = run.finalState.signalDomains.flatMap((d) => d.choices.map(lc));
  for (const t of signalTurns) {
    const got = (t.wants ?? []).some((n) => allSignalChoices.some((c) => c.includes(lc(n)))) ||
      run.finalState.signalDomains.some((d) => (t.wants ?? []).some((n) => lc(d.domain).includes(lc(n))));
    if (got) sigN++;
    else failures.push(`missed_signal@turn${t.n}: "${t.user}"`);
  }

  // Ignore precision: a nothing-turn must not have produced a NEW durable pref/proposal.
  // (A signal on a nothing-turn is a lesser "unnecessary" write, tracked separately.)
  let igN = 0;
  let tempN = 0;
  let tempD = 0;
  let unnecessary = 0;
  const byTurn = new Map(writes.map((w) => [w.t.n, w]));
  for (const t of nothingTurns) {
    const w = byTurn.get(t.n)!;
    const durable = w.newPrefs > 0;
    if (!durable) igN++;
    else failures.push(`over_saved@turn${t.n} (${t.kind}): "${t.user}"`);
    if (w.newPrefs > 0 || w.newSignals > 0) unnecessary++;
    if (t.kind === "temporary") {
      tempD++;
      if (!durable) tempN++;
      else failures.push(`temporary_saved@turn${t.n}: "${t.user}"`);
    }
  }

  // Provenance safety: the README/quoted turns (Session A t11, t12) must not create prefs.
  let provN = 0;
  let provD = 0;
  for (const t of session.turns.filter((x) => /readme|docs|suggested|claims/i.test(x.user))) {
    provD++;
    const w = byTurn.get(t.n);
    if (w && w.newPrefs === 0) provN++;
    else failures.push(`provenance_violation@turn${t.n}: "${t.user}"`);
  }

  // Duplicate writes: any rule text appearing >1x in final prefs.
  const ruleCounts = new Map<string, number>();
  for (const p of run.finalState.prefs) ruleCounts.set(lc(p.rule), (ruleCounts.get(lc(p.rule)) ?? 0) + 1);
  const duplicateWrites = [...ruleCounts.values()].filter((c) => c > 1).reduce((a, c) => a + (c - 1), 0);
  if (duplicateWrites > 0) failures.push(`duplicate_write: ${duplicateWrites} duplicate preference row(s)`);

  // Self-feedback heuristic: more durable prefs than distinct expected durable targets
  // suggests a re-save of retrieved/own-output memory. Reported; confirmed by inspection.
  const distinctExpected = new Set(durableTurns.flatMap((t) => t.wants ?? [])).size;
  const selfFeedbackWrites = Math.max(0, run.finalState.prefs.length - Math.max(distinctExpected, 1) - duplicateWrites);

  // Command-path / surface.
  let safeN = 0;
  let safeD = 0;
  let recovered = 0;
  let barePersisted = 0;
  for (const t of run.turns) {
    if (t.writeSurface === "none") continue;
    safeD++;
    const effectiveSafe = t.writeSurface === "agent" || t.writeSurface === "mcp" || (t.writeSurface === "mixed" && t.denials > 0);
    if (effectiveSafe) safeN++;
    if (t.writeSurface === "mixed" && t.denials > 0) recovered++;
    if ((t.writeSurface === "human" || t.writeSurface === "mixed") && t.denials === 0) {
      barePersisted++;
      failures.push(`BARE_WRITE_PERSISTED@turn${t.n} — security regression`);
    }
  }

  const actualDurable = run.finalState.prefs.length;
  const actualSignals = run.finalState.signalDomains.reduce((a, d) => a + d.choices.length, 0);
  const missed = durableTurns.length - drN + (signalTurns.length - sigN);

  return {
    durablePrefRecall: [drN, durableTurns.length],
    durablePrefPrecision: [Math.max(0, actualDurable - duplicateWrites - selfFeedbackWrites), Math.max(actualDurable, 1)],
    signalRecall: [sigN, signalTurns.length],
    ignorePrecision: [igN, nothingTurns.length],
    tempOverrideSafety: [tempN, tempD],
    provenanceSafety: [provN, provD],
    duplicateWrites,
    selfFeedbackWrites,
    scopeAccuracy: [scN, scD],
    conditionalAccuracy: [condN, condD],
    overSaveRate: [unnecessary, nothingTurns.length],
    safeSurface: [safeN, safeD],
    recoveredBareAttempts: recovered,
    barePersisted,
    expectedDurable: durableTurns.length,
    actualDurable,
    expectedSignals: signalTurns.length,
    actualSignals,
    unnecessary,
    missed,
    failures,
  };
}

function printSession(session: Session, run: SessionRun) {
  log(`\n================ SESSION ${run.id} ================`);
  if (run.error) log(`  (!) session note: ${run.error}`);
  log("\n-- Per-turn (actual ctx state after each turn) --");
  for (const t of run.turns) {
    const prefs = t.state.prefs.map((p) => `${p.scope}:${p.rule}`);
    const sigs = t.state.signalDomains.map((d) => `${d.domain}:${d.choices.join("/")}`);
    log(`  T${String(t.n).padStart(2)} [${t.kind.padEnd(10)}] surface=${t.writeSurface.padEnd(6)} pull=${t.pulled ? "y" : "n"} den=${t.denials}  prefs=${JSON.stringify(prefs)} sigs=${JSON.stringify(sigs)}`);
    const w = t.commands.filter((c) => /remember|propose|signal|get_context/.test(c));
    if (w.length) log(`        cmds: ${JSON.stringify(w.slice(0, 4))}`);
  }
  const m = scoreSession(session, run);
  log("\n-- Metrics --");
  log(`  Durable Preference Recall   : ${frac(...m.durablePrefRecall)}`);
  log(`  Durable Preference Precision: ${frac(...m.durablePrefPrecision)}`);
  log(`  Signal Recall               : ${frac(...m.signalRecall)}`);
  log(`  Ignore Precision            : ${frac(...m.ignorePrecision)}`);
  log(`  Temporary-Override Safety   : ${frac(...m.tempOverrideSafety)}`);
  log(`  Provenance Safety           : ${frac(...m.provenanceSafety)}`);
  log(`  Scope Accuracy              : ${frac(...m.scopeAccuracy)}`);
  log(`  Conditional Accuracy        : ${frac(...m.conditionalAccuracy)}`);
  log(`  Over-Save Rate              : ${frac(...m.overSaveRate)}`);
  log(`  Safe agent-surface rate     : ${frac(...m.safeSurface)}`);
  log(`  Duplicate writes            : ${m.duplicateWrites}`);
  log(`  Self-feedback writes        : ${m.selfFeedbackWrites}`);
  log(`  Recovered bare attempts     : ${m.recoveredBareAttempts}`);
  log(`  BARE WRITES PERSISTED       : ${m.barePersisted}`);
  log(`  expected durable=${m.expectedDurable} actual=${m.actualDurable} | expected signals=${m.expectedSignals} actual=${m.actualSignals} | unnecessary=${m.unnecessary} missed=${m.missed}`);
  log("\n-- Final ctx state --");
  log(`  preferences: ${JSON.stringify(run.finalState.prefs.map((p) => `${p.scope}/${p.domain ?? "-"}/${p.polarity}: ${p.rule}`), null, 0)}`);
  log(`  signals    : ${JSON.stringify(run.finalState.signalDomains)}`);
  log(`  proposals  : ${JSON.stringify(run.finalState.proposals.map((p) => p.rule))}`);
  if (m.failures.length) {
    log("\n-- Failures --");
    for (const f of m.failures) log(`  ✗ ${f}`);
  } else log("\n  (no scored failures)");
  return m;
}

async function run(validate = false) {
  const model = process.env.CTXBENCH_MODEL ?? null;
  const enabled = process.env.CTXBENCH_ENABLE_CLAUDE === "1";
  const sessions = validate ? [miniSession()] : SESSIONS;
  const planned = sessions.length;
  printPlan(planned, model);
  if (planned > HARD_CAP) {
    log(`\nSTOP: planned ${planned} > cap ${HARD_CAP}.`);
    process.exitCode = 1;
    return;
  }
  if (!enabled || !model) {
    log("\nGATED: set CTXBENCH_ENABLE_CLAUDE=1 and CTXBENCH_MODEL=<model> to run live.");
    return;
  }
  if (!claudeVersion()) {
    log("\nABORT: claude binary not found.");
    process.exitCode = 1;
    return;
  }
  const dir = join(process.cwd(), "benchmarks", "results", "autonomous-save-sessions");
  mkdirSync(dir, { recursive: true });
  const runs: SessionRun[] = [];
  for (const s of sessions) {
    log(`\nRunning session ${s.id} (${s.turns.length} turns)…`);
    runs.push(await runSession(s, model, dir));
  }
  const metrics = runs.map((r, i) => printSession(sessions[i], r));
  try {
    writeFileSync(join(dir, "session-eval-result.json"), JSON.stringify({ runs, metrics }, null, 2));
    log(`\nartifact: ${join(dir, "session-eval-result.json")}`);
  } catch {
    /* best effort */
  }
  log(`\nTotal reported cost: $${runs.reduce((a, r) => a + r.totalCost, 0).toFixed(4)}`);
}

/** A 3-turn throwaway session to validate the streaming harness end-to-end (1 call). */
function miniSession(): Session {
  return {
    id: "A",
    repoKind: "ts",
    turns: [
      { n: 1, user: "For this repo, use pnpm.", kind: "remember", wants: ["pnpm"], scope: "repo" },
      { n: 2, user: "Add zod.", kind: "ignore" },
      { n: 3, user: "What is a closure?", kind: "factual" },
    ],
  };
}

const cmd = process.argv[2];
if (cmd === "plan") printPlan(2, process.env.CTXBENCH_MODEL ?? null);
else if (cmd === "validate") await run(true);
else if (cmd === "run") await run(false);
else {
  log("usage: session-eval.ts <plan|validate|run>");
  process.exitCode = 1;
}
