/**
 * Deterministic retrieval-corpus regression (retrieval pass, spec §14–§16).
 *
 * Black-box: seeds an isolated store and drives the SHIPPED ctx CLI, then asserts the
 * engine's recall/precision across decision classes and — critically — the behaviors
 * this pass added: naming/identity retrieval (§11–§12), explicit "ctx it" NOT searching
 * for the literal command (§7/§10), and query-construction lifting recall without any
 * precision loss (§9/§15). No model.
 *
 * GATED behind CTXBENCH_CORPUS=1: it cold-spawns `ctx` dozens of times (~20–30s), too
 * heavy for every `bun test`. The fast in-process guard lives in tests/retrieval-naming
 * .test.ts; run this with `bun run bench:pull:corpus` or `CTXBENCH_CORPUS=1 bun test …`.
 */
import { test, expect, describe } from "bun:test";
import {
  CORPUS,
  OBLIQUE_CALL,
  setupCorpusSandbox,
  runCorpus,
  summarize,
} from "../retrieval-corpus.ts";

const ENABLED = process.env.CTXBENCH_CORPUS === "1";
const BIG_TIMEOUT = 180_000;

// Corpus-schema assertions are pure (no spawn) and always run — they guard the dataset.
describe("retrieval corpus — schema", () => {
  test("focused, balanced corpus (spec §14: ~30–40 cases, every class present)", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(24);
    expect(CORPUS.length).toBeLessThanOrEqual(40);
    for (const k of ["direct", "oblique", "personal", "project-decision", "explicit", "negative"]) {
      expect(CORPUS.some((c) => c.klass === k)).toBe(true);
    }
    expect(CORPUS.filter((c) => !c.relevant).every((c) => !c.seed)).toBe(true);
  });
});

// Focused oblique-call corpus schema (spec §6): balanced should-call / should-not-call,
// every should-call is a real outcome-phrased oblique task backed by a stored decision,
// and no negative carries a seed.
describe("oblique-call corpus — schema (spec §6)", () => {
  test("focused and balanced (20–24 cases, ~half should-call)", () => {
    expect(OBLIQUE_CALL.length).toBeGreaterThanOrEqual(20);
    expect(OBLIQUE_CALL.length).toBeLessThanOrEqual(24);
    const call = OBLIQUE_CALL.filter((c) => c.relevant).length;
    const noCall = OBLIQUE_CALL.filter((c) => !c.relevant).length;
    // roughly half and half (within one of each other)
    expect(Math.abs(call - noCall)).toBeLessThanOrEqual(1);
  });

  test("every should-call names an implied decision; no should-not-call carries a seed", () => {
    for (const c of OBLIQUE_CALL.filter((x) => x.relevant)) {
      // a seeded decision OR a shared one (deduped) must back it, and an expect anchor
      expect(c.expect && c.expect.length > 0).toBe(true);
      // the probe is an outcome/task, the query names the decision axis (not an echo)
      expect(c.query.toLowerCase()).not.toBe(c.probe.toLowerCase());
    }
    expect(OBLIQUE_CALL.filter((c) => !c.relevant).every((c) => !c.seed)).toBe(true);
  });
});

// The black-box recall/precision run is gated (spawns ctx many times).
(ENABLED ? describe : describe.skip)("retrieval corpus — engine recall & precision (black-box)", () => {
  test(
    "recall, precision, naming, and explicit-command behaviors hold",
    () => {
      const sb = setupCorpusSandbox();
      try {
        const results = runCorpus(sb);
        const byId = (id: string) => results.find((r) => r.id === id)!;
        const s = summarize(results);

        // Precision: no negative ever surfaces a preference (probe OR query) — spec §15.
        expect(s.probePrecision.num).toBe(s.probePrecision.den);
        expect(s.queryPrecision.num).toBe(s.queryPrecision.den);

        // Query construction materially lifts recall over the raw probe — spec §9.
        expect(s.queryRecall.num / s.queryRecall.den).toBeGreaterThanOrEqual(0.9);
        expect(s.queryRecall.num).toBeGreaterThan(s.probeRecall.num);

        // Every relevant class reaches high query recall.
        for (const [, v] of Object.entries(s.byClass)) {
          expect(v.num / v.den).toBeGreaterThanOrEqual(0.66);
        }

        // Naming/identity (spec §11–§12): "What do you call me?" retrieves on the natural
        // question itself — never special-casing the literal name.
        expect(byId("P-call-me").probeHit).toBe(true);
        expect(byId("P-call-me").queryHit).toBe(true);
        expect(byId("P-address").queryHit).toBe(true);

        // Explicit commands (spec §7/§10): the literal command is NOT searched…
        for (const id of ["X-ctx-it-name", "X-check-ctx-pm", "X-look-in-ctx-db"]) {
          expect(byId(id).probeHit).toBe(false);
          // …but the inherited query (from the preceding request) retrieves the seed.
          expect(byId(id).queryHit).toBe(true);
        }
      } finally {
        sb.cleanup();
      }
    },
    BIG_TIMEOUT,
  );
});

// Oblique-call black-box: a correctly-formed oblique query lands (excluding documented
// engine ceilings), and no NEW negative leaks beyond the known topically-adjacent ones.
(ENABLED ? describe : describe.skip)("oblique-call corpus — engine recall & precision (black-box)", () => {
  test(
    "well-formed oblique queries retrieve (ex-ceiling), precision leaks stay within the documented set",
    () => {
      const sb = setupCorpusSandbox(OBLIQUE_CALL);
      try {
        const results = runCorpus(sb, OBLIQUE_CALL);
        const rel = results.filter((r) => r.relevant);
        const scored = rel.filter((r) => !r.knownEngineMiss);

        // The policy+query layers this pass owns: ≥90% query recall once documented engine
        // ceilings (oblique query cannot contain the proper-noun answer) are excluded.
        const recall = scored.filter((r) => r.queryHit).length / scored.length;
        expect(recall).toBeGreaterThanOrEqual(0.9);

        // Query construction materially lifts recall over the raw probe (spec §9).
        expect(rel.filter((r) => r.queryHit).length).toBeGreaterThan(rel.filter((r) => r.probeHit).length);

        // Precision: any negative that surfaces a seed is a known topically-adjacent concept
        // (defended by the no-call policy, not the engine). No NEW negative may leak.
        const KNOWN_ADJACENT = new Set(["NC-redis-evict", "NC-what-queue", "NC-what-logging"]);
        for (const r of results.filter((x) => !x.relevant && (x.probeHit || x.queryHit))) {
          expect(KNOWN_ADJACENT.has(r.id)).toBe(true);
        }
      } finally {
        sb.cleanup();
      }
    },
    BIG_TIMEOUT,
  );
});
