/**
 * Regression test for the ctx failure taxonomy (spec §35), tightened after the first real
 * pilot. The key fix: a POSITIVE repo-scoped scenario whose preference was never delivered
 * is a delivery failure (retrieval miss), NOT a `scope_leak`. `scope_leak` is reserved for
 * the cross-repo case where a preference was wrongly applied (appliesHere === false).
 */
import { describe, test, expect } from "bun:test";
import { classifyCtxFailure, type Verification } from "../src/conditions.ts";
import { byId } from "../scenarios/index.ts";

const V = (over: Partial<Verification> = {}): Verification => ({
  ctxDetected: false,
  ctxPersisted: true,
  ctxRetrievalCalled: true,
  ctxDeliveredPreference: true,
  ctxInjectedChars: 100,
  ctxApproxTokens: 25,
  ctxRetrievalMs: 5,
  poisonRefused: null,
  ...over,
});

const repoScoped = byId("repo-pnpm-add-uuid")!; // positive, repo-scoped
const crossRepo = byId("negative-repo-sqlite-leak")!; // appliesHere:false, crossRepoLeak
const correction = byId("correction-vitest-to-jest")!;

describe("classifyCtxFailure", () => {
  test("pass → null", () => {
    expect(classifyCtxFailure(repoScoped, V(), true, false)).toBeNull();
  });
  test("positive repo-scoped + not delivered → delivery_failure (NOT scope_leak)", () => {
    expect(classifyCtxFailure(repoScoped, V({ ctxDeliveredPreference: false }), false, false)).toBe("delivery_failure");
  });
  test("cross-repo negative that failed → scope_leak", () => {
    expect(classifyCtxFailure(crossRepo, V({ ctxDeliveredPreference: false }), false, false)).toBe("scope_leak");
  });
  test("correction delivered but failed → stale_memory", () => {
    expect(classifyCtxFailure(correction, V({ ctxDeliveredPreference: true }), false, false)).toBe("stale_memory");
  });
  test("not persisted → persistence_failure", () => {
    expect(classifyCtxFailure(repoScoped, V({ ctxPersisted: false }), false, false)).toBe("persistence_failure");
  });
  test("delivered + positive + ignored → adherence_failure", () => {
    expect(classifyCtxFailure(byId("bun-add-zod")!, V(), false, false)).toBe("adherence_failure");
  });
});
