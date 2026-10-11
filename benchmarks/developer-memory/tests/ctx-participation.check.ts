/**
 * ctx-participation integration check (spec §34, §53). Drives the REAL `ctx` CLI in full
 * isolation — NO model involved — to verify the delivery half of the thesis deterministically:
 *   - ctx persists a user preference and delivers it at probe time (participation);
 *   - the control condition is genuinely ctx-free (contamination check);
 *   - an adversarial non-user write is REFUSED (poisoning resistance, provenance);
 *   - a repo-scoped preference recorded in another repo does NOT leak here (scope).
 *
 * Named *.check.ts so the default `bun test` does not collect it (it spawns subprocesses).
 * Run explicitly: `bun test benchmarks/developer-memory/tests/ctx-participation.check.ts`.
 */
import { describe, test, expect } from "bun:test";
import { prepareTrial } from "../src/conditions.ts";
import { MockAgent } from "../src/adapters/mock.ts";
import { score } from "../src/scorers.ts";
import { byId } from "../scenarios/index.ts";

const mock = new MockAgent();

function scenario(id: string) {
  const s = byId(id);
  if (!s) throw new Error(`missing scenario ${id}`);
  return s;
}

describe("ctx participation (real CLI, no model)", () => {
  test("ctx persists and delivers the preference at probe time", async () => {
    const p = prepareTrial({ scenario: scenario("bun-add-zod"), condition: "ctx", interference: "medium", freshSession: false, trial: 1, seed: 7 });
    try {
      expect(p.infraError).toBeUndefined();
      expect(p.verification.ctxPersisted).toBe(true);
      expect(p.verification.ctxRetrievalCalled).toBe(true);
      expect(p.verification.ctxDeliveredPreference).toBe(true);
      expect((p.verification.ctxInjectedChars ?? 0)).toBeGreaterThan(0);
      expect(p.request.injectedContext.toLowerCase()).toContain("bun");
      // End-to-end: the mock, seeing the delivered rule, adheres.
      const res = await mock.run(p.request);
      expect(res.supported).toBe(true);
      expect(score(scenario("bun-add-zod").scorer, res.behavior).pass).toBe(true);
    } finally {
      p.sandbox.cleanup();
    }
  });

  test("control is genuinely ctx-free (no injected context)", async () => {
    const p = prepareTrial({ scenario: scenario("bun-add-zod"), condition: "control", interference: "medium", freshSession: false, trial: 1, seed: 7 });
    try {
      expect(p.request.injectedContext).toBe("");
      expect(p.verification.ctxDetected).toBe(false);
      expect(p.verification.ctxRetrievalCalled).toBeNull();
    } finally {
      p.sandbox.cleanup();
    }
  });

  test("control forgets across a fresh session; ctx survives it", async () => {
    const ctrl = prepareTrial({ scenario: scenario("bun-add-zod"), condition: "control", interference: "medium", freshSession: true, trial: 1, seed: 7 });
    const ctx = prepareTrial({ scenario: scenario("bun-add-zod"), condition: "ctx", interference: "medium", freshSession: true, trial: 1, seed: 7 });
    try {
      const ctrlRes = await mock.run(ctrl.request);
      const ctxRes = await mock.run(ctx.request);
      // Fresh session drops the conversation: control has no memory → defaults (fails);
      // ctx re-delivers the preference → adheres.
      expect(score(scenario("bun-add-zod").scorer, ctrlRes.behavior).pass).toBe(false);
      expect(score(scenario("bun-add-zod").scorer, ctxRes.behavior).pass).toBe(true);
    } finally {
      ctrl.sandbox.cleanup();
      ctx.sandbox.cleanup();
    }
  });

  test("poisoning: adversarial non-user write is refused; real preference still delivered", async () => {
    const p = prepareTrial({ scenario: scenario("poison-readme-prefers-npm"), condition: "ctx", interference: "medium", freshSession: false, trial: 1, seed: 7 });
    try {
      expect(p.verification.poisonRefused).toBe(true);
      expect(p.request.injectedContext.toLowerCase()).toContain("bun");
      expect(p.request.injectedContext.toLowerCase()).not.toContain("prefers npm");
    } finally {
      p.sandbox.cleanup();
    }
  });

  test("scope: a repo preference from another repo does not leak here", async () => {
    const p = prepareTrial({ scenario: scenario("negative-repo-sqlite-leak"), condition: "ctx", interference: "light", freshSession: true, trial: 1, seed: 7 });
    try {
      // The SQLite preference was recorded against a DIFFERENT repo identity; retrieval here
      // must not deliver it, so a fresh-session agent has nothing to apply.
      expect(p.verification.ctxDeliveredPreference).toBe(false);
      expect(p.request.injectedContext.toLowerCase()).not.toContain("sqlite");
    } finally {
      p.sandbox.cleanup();
    }
  });
});
