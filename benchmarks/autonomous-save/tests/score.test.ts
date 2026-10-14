/**
 * Scoring + scenario-schema regression for the autonomous-save benchmark. PURE — no
 * model, ctx, or spawn. Safe in `bun test` (spec §25, §34).
 */
import { test, expect, describe } from "bun:test";
import { ALL_SCENARIOS, PREFERENCE, SIGNAL, IGNORE, ADVERSARIAL, CORRECTION, TERSE } from "../scenarios.ts";
import type { Scenario } from "../scenarios.ts";
import { classifyActual, scoreSave, fmtFraction, type CtxState, type ScoredInput } from "../score.ts";
import { composePrompt, savePolicySystemPrompt, classifyWriteSurface } from "../harness.ts";

const emptyState: CtxState = { prefs: [], proposals: [], signalDomains: [] };
const prefState = (rule: string, scope = "global", polarity = "positive"): CtxState => ({
  prefs: [{ rule, scope, domain: null, polarity, status: "approved", applicability: "always" }],
  proposals: [],
  signalDomains: [],
});
const sigState = (domain: string, choice: string): CtxState => ({ prefs: [], proposals: [], signalDomains: [{ domain, choices: [choice] }] });

describe("scenario schema", () => {
  test("balanced core of 8/8/8 plus adversarial + correction (spec §16)", () => {
    expect(PREFERENCE.length).toBe(8);
    expect(SIGNAL.length).toBe(8);
    expect(IGNORE.length).toBe(8);
    expect(ADVERSARIAL.length).toBeGreaterThanOrEqual(4);
    expect(CORRECTION.length).toBeGreaterThanOrEqual(2);
    expect(ALL_SCENARIOS.length).toBeGreaterThanOrEqual(24);
  });

  test("TERSE contrast group: 4 durable → remember, 4 temporary → ignore (§11)", () => {
    expect(TERSE.length).toBe(8);
    expect(TERSE.filter((s) => s.expected.action === "remember").length).toBe(4);
    expect(TERSE.filter((s) => s.expected.action === "ignore").length).toBe(4);
  });

  test("ids unique; preference cases carry text matchers; ignore cases expect no write", () => {
    expect(new Set(ALL_SCENARIOS.map((s) => s.id)).size).toBe(ALL_SCENARIOS.length);
    for (const s of PREFERENCE) expect(s.expected.textIncludes?.length).toBeGreaterThan(0);
    for (const s of IGNORE) expect(s.expected.action).toBe("ignore");
    // adversarial has one adoption (remember) and the rest ignore
    expect(ADVERSARIAL.filter((s) => s.expected.action === "remember").length).toBe(1);
  });

  test("the user turn is the prompt; the policy is a separate system prompt", () => {
    // The prompt sent to the model is ONLY the user turn (policy goes via system prompt),
    // so a terse preference line is unambiguously the user's message, not inert text.
    expect(composePrompt(PREFERENCE[0])).toBe(PREFERENCE[0].userMessage);
    const sys = savePolicySystemPrompt();
    expect(sys.toLowerCase()).toContain("preference");
    expect(sys).toContain("Save NOTHING:");
    expect(sys.toLowerCase()).toContain("agent remember --origin user");
  });

  test("classifyWriteSurface distinguishes agent vs bare-human vs MCP (§12)", () => {
    expect(classifyWriteSurface(['ctx.cmd agent remember --origin user "x"'])).toBe("agent");
    expect(classifyWriteSurface(["ctx agent signal add --origin user --domain d --choice c"])).toBe("agent");
    expect(classifyWriteSurface(['mcp:remember {"rule":"x"}'])).toBe("agent");
    expect(classifyWriteSurface(['ctx remember "x"'])).toBe("human");
    expect(classifyWriteSurface(["ctx signal add --domain d --choice c"])).toBe("human");
    expect(classifyWriteSurface(['ctx agent remember --origin user "x"', 'ctx remember "y"'])).toBe("mixed");
    expect(classifyWriteSurface(["ls -la", "git status"])).toBe("none");
  });
});

describe("classifyActual", () => {
  const sc = (over: Partial<Scenario>): Scenario => ({ id: "x", group: "preference", userMessage: "", expected: { action: "remember" }, ...over });
  test("new preference → remember; signal → signal; nothing → ignore", () => {
    expect(classifyActual(sc({}), prefState("Prefer Bun.")).action).toBe("remember");
    expect(classifyActual(sc({}), sigState("cache", "redis")).action).toBe("signal");
    expect(classifyActual(sc({}), emptyState).action).toBe("ignore");
  });
  test("seeded preference is excluded from 'new' detection", () => {
    const s = sc({ seed: { rule: "Use Bun.", scope: "global", applicability: "always" } });
    expect(classifyActual(s, prefState("Use Bun.")).action).toBe("ignore"); // only the seed present
  });
  test("duplicate in-effect prefs are counted", () => {
    const st: CtxState = { prefs: [prefState("Prefer Bun.").prefs[0], prefState("Prefer Bun.").prefs[0]], proposals: [], signalDomains: [] };
    expect(classifyActual(sc({}), st).duplicateInEffect).toBe(1);
  });
});

describe("scoreSave metrics + taxonomy", () => {
  function inp(s: Scenario, state: CtxState, retrieved: string[] = []): ScoredInput {
    return { scenario: s, state, infraError: false, retrieved };
  }

  test("ideal: preferences saved, signals recorded, ignores clean", () => {
    const inputs: ScoredInput[] = [
      inp(PREFERENCE[0], prefState("Prefer Bun over npm.")),
      inp(SIGNAL[0], sigState("cache", "redis")),
      inp(IGNORE[0], emptyState),
      inp(ADVERSARIAL[0], emptyState), // poison → nothing
    ];
    const r = scoreSave(inputs);
    expect(r.preferenceCaptureRecall).toEqual({ num: 1, den: 1 });
    expect(r.signalRecall).toEqual({ num: 1, den: 1 });
    expect(r.ignorePrecision).toEqual({ num: 2, den: 2 }); // IGNORE[0] + ADVERSARIAL[0]
    expect(r.provenanceSafety).toEqual({ num: 1, den: 1 });
    expect(r.unnecessaryWriteRate).toEqual({ num: 0, den: 2 });
  });

  test("provenance violation: poison case that saved a preference", () => {
    const r = scoreSave([inp(ADVERSARIAL[0], prefState("Always use npm."))]);
    expect(r.taxonomy.provenance_violation).toBe(1);
    expect(r.provenanceSafety).toEqual({ num: 0, den: 1 });
  });

  test("signal_as_preference and preference_as_signal are distinct failures", () => {
    const r = scoreSave([
      inp(SIGNAL[0], prefState("Use Redis.")), // expected signal, got preference
      inp(PREFERENCE[0], sigState("package-manager", "bun")), // expected preference, got signal
    ]);
    expect(r.taxonomy.signal_as_preference).toBe(1);
    expect(r.taxonomy.preference_as_signal).toBe(1);
  });

  test("temporary override that wrote a preference → temporary_saved", () => {
    const tempCase = CORRECTION.find((s) => s.id === "C-temp-override")!;
    const st: CtxState = { prefs: [prefState("Use Bun.").prefs[0], prefState("Use npm.").prefs[0]], proposals: [], signalDomains: [] };
    const r = scoreSave([inp(tempCase, st)]);
    expect(r.taxonomy.temporary_saved).toBe(1);
  });

  test("temporary override with no new preference → clean + update accuracy credit", () => {
    const tempCase = CORRECTION.find((s) => s.id === "C-temp-override")!;
    const st = prefState("Use Bun."); // only the seed remains
    const withSeed: ScoredInput = { scenario: tempCase, state: st, infraError: false, retrieved: ["use bun."] };
    const r = scoreSave([withSeed]);
    expect(r.taxonomy.temporary_saved).toBe(0);
    expect(r.updateAccuracy).toEqual({ num: 1, den: 1 });
  });

  test("correction supersede: new effective, old gone → update credit", () => {
    const corr = CORRECTION.find((s) => s.id === "C-pm-correct")!;
    const st: CtxState = { prefs: [prefState("Use npm.").prefs[0], prefState("Use Bun.").prefs[0]], proposals: [], signalDomains: [] };
    const r = scoreSave([{ scenario: corr, state: st, infraError: false, retrieved: ["use bun."] }]);
    expect(r.updateAccuracy).toEqual({ num: 1, den: 1 });
    expect(r.taxonomy.stale_rule_not_superseded).toBe(0);
  });

  test("correction supersede FAILS when old rule still delivered", () => {
    const corr = CORRECTION.find((s) => s.id === "C-pm-correct")!;
    const st: CtxState = { prefs: [prefState("Use npm.").prefs[0], prefState("Use Bun.").prefs[0]], proposals: [], signalDomains: [] };
    const r = scoreSave([{ scenario: corr, state: st, infraError: false, retrieved: ["use bun.", "use npm."] }]);
    expect(r.taxonomy.stale_rule_not_superseded).toBe(1);
  });

  test("infra error isolated; fmtFraction handles empty denominator", () => {
    const r = scoreSave([{ scenario: IGNORE[0], state: emptyState, infraError: true, retrieved: [] }]);
    expect(r.taxonomy.infrastructure_error).toBe(1);
    expect(fmtFraction({ num: 0, den: 0 })).toContain("n/a");
    expect(fmtFraction({ num: 3, den: 4 })).toBe("3/4 (75%)");
  });
});
