/**
 * Scoring + scenario-schema regression tests for the autonomous-pull benchmark.
 * PURE — no model, no ctx, no spawn. Safe to run in `bun test` (spec §25).
 */
import { test, expect, describe } from "bun:test";
import { ALL_SCENARIOS, RELEVANT, IRRELEVANT, seedsFor } from "../scenarios.ts";
import {
  scorePilot,
  summarizeDeterministic,
  fmtFraction,
  classifyRelevantCall,
  type PilotTrial,
  type DeterministicResult,
} from "../score.ts";
import { isCtxGetCommand, extractTaskArg, parseStream, composePilotPrompt } from "../harness.ts";

describe("scenario schema", () => {
  test("has 16–20 scenarios, balanced relevant/irrelevant (spec §8)", () => {
    expect(ALL_SCENARIOS.length).toBeGreaterThanOrEqual(16);
    expect(ALL_SCENARIOS.length).toBeLessThanOrEqual(20);
    expect(RELEVANT.length).toBeGreaterThanOrEqual(8);
    expect(IRRELEVANT.length).toBeGreaterThanOrEqual(8);
  });

  test("every relevant scenario seeds a preference with an expected-rule matcher", () => {
    for (const s of RELEVANT) {
      expect(s.seed).toBeDefined();
      expect(s.seed!.rule.length).toBeGreaterThan(0);
      expect(s.expectRuleIncludes && s.expectRuleIncludes.length).toBeGreaterThan(0);
    }
  });

  test("irrelevant scenarios carry no seed", () => {
    for (const s of IRRELEVANT) expect(s.seed).toBeUndefined();
  });

  test("scenario ids are unique and classes are diverse (spec §9)", () => {
    const ids = new Set(ALL_SCENARIOS.map((s) => s.id));
    expect(ids.size).toBe(ALL_SCENARIOS.length);
    const classes = new Set(RELEVANT.map((s) => s.klass));
    expect(classes.size).toBeGreaterThanOrEqual(8);
  });

  test("seedsFor returns one entry per relevant seed", () => {
    expect(seedsFor(RELEVANT).length).toBe(RELEVANT.length);
  });
});

describe("tool-call capture (spec §13)", () => {
  test("detects CLI ctx get, ctx.cmd get, agent context, and MCP get_context", () => {
    expect(isCtxGetCommand('ctx get --task "add uuid"')).toBe(true);
    expect(isCtxGetCommand('ctx.cmd get --cwd "." --task "x"')).toBe(true);
    expect(isCtxGetCommand("ctx agent context --stdin")).toBe(true);
    expect(isCtxGetCommand("get_context")).toBe(true);
    expect(isCtxGetCommand("npm install uuid")).toBe(false);
    expect(isCtxGetCommand("ctx stats")).toBe(false);
  });

  test("extracts --task argument in quoted and bare forms", () => {
    expect(extractTaskArg('ctx get --task "write tests for the parser"')).toBe("write tests for the parser");
    expect(extractTaskArg("ctx get --task caching")).toBe("caching");
    expect(extractTaskArg("ctx get")).toBeNull();
  });

  test("parseStream captures commands, final text, and cost from stream-json", () => {
    const stream = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: 'ctx get --task "add uuid"' } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Using nanoid." }] } }),
      JSON.stringify({ type: "result", result: "Using nanoid.", total_cost_usd: 0.02 }),
    ].join("\n");
    const p = parseStream(stream);
    expect(p.commands.some(isCtxGetCommand)).toBe(true);
    expect(p.finalText).toContain("nanoid");
    expect(p.costUsd).toBe(0.02);
  });

  test("composePilotPrompt carries the standing instruction and the probe", () => {
    const prompt = composePilotPrompt("Add uuid.");
    expect(prompt).toContain("Add uuid.");
    expect(prompt.toLowerCase()).toContain("could reasonably depend on");
    expect(prompt).toContain("Retrieve when the task is something like:");
  });
});

describe("metric scoring (spec §11, §22)", () => {
  const t = (over: Partial<PilotTrial>): PilotTrial => ({
    scenarioId: over.scenarioId ?? "x",
    relevant: over.relevant ?? true,
    calledCtx: over.calledCtx ?? false,
    ctxQuery: over.ctxQuery ?? null,
    retrievalReturnedExpected: over.retrievalReturnedExpected ?? null,
    contextAlreadyPushed: over.contextAlreadyPushed ?? false,
    adheredAfterPull: over.adheredAfterPull ?? null,
    infraError: over.infraError ?? false,
  });

  test("ideal run: perfect recall/precision, zero unnecessary, full adherence", () => {
    const trials = [
      t({ scenarioId: "R1", relevant: true, calledCtx: true, retrievalReturnedExpected: true, adheredAfterPull: true }),
      t({ scenarioId: "R2", relevant: true, calledCtx: true, retrievalReturnedExpected: true, adheredAfterPull: true }),
      t({ scenarioId: "N1", relevant: false, calledCtx: false }),
      t({ scenarioId: "N2", relevant: false, calledCtx: false }),
    ];
    const m = scorePilot(trials);
    expect(m.toolRecall).toEqual({ num: 2, den: 2 });
    expect(m.toolPrecision).toEqual({ num: 2, den: 2 });
    expect(m.unnecessaryCallRate).toEqual({ num: 0, den: 2 });
    expect(m.retrievalSuccessAfterCall).toEqual({ num: 2, den: 2 });
    expect(m.adherenceAfterPull).toEqual({ num: 2, den: 2 });
    expect(m.taxonomy.no_call).toBe(0);
  });

  test("taxonomy: no_call, unnecessary_call, adherence_failure, bad_query, retrieval_miss", () => {
    const trials = [
      t({ scenarioId: "R-nocall", relevant: true, calledCtx: false }),
      t({ scenarioId: "R-badq", relevant: true, calledCtx: true, retrievalReturnedExpected: false }),
      t({ scenarioId: "R-miss", relevant: true, calledCtx: true, retrievalReturnedExpected: false }),
      t({ scenarioId: "R-adher", relevant: true, calledCtx: true, retrievalReturnedExpected: true, adheredAfterPull: false }),
      t({ scenarioId: "N-unnec", relevant: false, calledCtx: true }),
    ];
    // Canonical probe retrieves for R-badq (so model query was bad) but NOT for R-miss (engine gap).
    const m = scorePilot(trials, { "R-badq": true, "R-miss": false });
    expect(m.taxonomy.no_call).toBe(1);
    expect(m.taxonomy.bad_query).toBe(1);
    expect(m.taxonomy.retrieval_miss).toBe(1);
    expect(m.taxonomy.adherence_failure).toBe(1);
    expect(m.taxonomy.unnecessary_call).toBe(1);
    // 4 relevant, 3 of them called (R-nocall abstained); 4 total calls (incl. N-unnec).
    expect(m.toolRecall).toEqual({ num: 3, den: 4 });
    expect(m.toolPrecision).toEqual({ num: 3, den: 4 });
  });

  test("duplicate call counted when context was already pushed (spec §19)", () => {
    const trials = [
      t({ scenarioId: "R-dup", relevant: true, calledCtx: true, contextAlreadyPushed: true, retrievalReturnedExpected: true, adheredAfterPull: true }),
    ];
    const m = scorePilot(trials);
    expect(m.duplicateCallCount).toBe(1);
    expect(m.taxonomy.duplicate_call).toBe(1);
  });

  test("infrastructure error is isolated, not counted as no_call", () => {
    const m = scorePilot([t({ scenarioId: "R-infra", relevant: true, calledCtx: false, infraError: true })]);
    expect(m.taxonomy.infrastructure_error).toBe(1);
    expect(m.taxonomy.no_call).toBe(0);
  });

  test("classifyRelevantCall splits bad_query vs retrieval_miss", () => {
    const miss = t({ relevant: true, calledCtx: true, retrievalReturnedExpected: false });
    expect(classifyRelevantCall(miss, true)).toBe("bad_query");
    expect(classifyRelevantCall(miss, false)).toBe("retrieval_miss");
    expect(classifyRelevantCall(t({ retrievalReturnedExpected: true }), true)).toBe("ok");
  });

  test("fmtFraction reports exact fraction, and n/a for empty denominator (spec §16)", () => {
    expect(fmtFraction({ num: 5, den: 6 })).toBe("5/6 (83%)");
    expect(fmtFraction({ num: 0, den: 0 })).toContain("n/a");
  });

  test("summarizeDeterministic counts relevant hits and irrelevant leaks", () => {
    const det: DeterministicResult[] = [
      { scenarioId: "R1", relevant: true, retrievedExpected: true, returnedRuleCount: 1, renderedChars: 80, approxTokens: 20 },
      { scenarioId: "R2", relevant: true, retrievedExpected: false, returnedRuleCount: 0, renderedChars: 0, approxTokens: 0 },
      { scenarioId: "N1", relevant: false, retrievedExpected: false, returnedRuleCount: 0, renderedChars: 0, approxTokens: 0 },
      { scenarioId: "N2", relevant: false, retrievedExpected: true, returnedRuleCount: 2, renderedChars: 120, approxTokens: 30 },
    ];
    const s = summarizeDeterministic(det);
    expect(s.relevantRetrieved).toEqual({ num: 1, den: 2 });
    expect(s.irrelevantClean).toEqual({ num: 1, den: 2 });
    expect(s.maxRenderedChars).toBe(120);
  });
});
