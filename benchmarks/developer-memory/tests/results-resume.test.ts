import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultStore, trialKey, type TrialRecord } from "../src/results.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ctxbench-res-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rec(over: Partial<TrialRecord>): TrialRecord {
  return {
    scenarioId: "s1", category: "explicit-default", split: "dev", condition: "ctx",
    sourceAgent: "mock", destinationAgent: "mock", trial: 1, freshSession: false,
    interference: "medium", probe: "p", expected: "e", forbidden: "f", appliesHere: true,
    outcome: "pass", pass: true, scoreReason: "ok", ctxFailureClass: null,
    ctxDetected: false, ctxPersisted: true, ctxRetrievalCalled: true, ctxDeliveredPreference: true, poisonRefused: null,
    ctxInjectedChars: 100, ctxApproxTokens: 25, ctxRetrievalMs: 5,
    artifactPath: null, transcriptPath: null, agentSessionId: null, costUsd: null, permissionDenials: null,
    errors: [], seed: 1, at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("ResultStore persistence + resume", () => {
  test("records append and mark completed", () => {
    const root = tmp();
    const store = new ResultStore(root, "run1");
    const r = rec({});
    store.record(r);
    expect(store.isCompleted(trialKey(r))).toBe(true);
    expect(store.readAll().length).toBe(1);
  });

  test("a resume skips completed trials but retries infra errors", () => {
    const root = tmp();
    const s1 = new ResultStore(root, "run1");
    s1.record(rec({ scenarioId: "pass-one", outcome: "pass" }));
    s1.record(rec({ scenarioId: "infra-one", outcome: "infrastructure_error", pass: false }));

    const s2 = new ResultStore(root, "run1"); // resume
    expect(s2.isCompleted(trialKey(rec({ scenarioId: "pass-one" })))).toBe(true);
    expect(s2.isCompleted(trialKey(rec({ scenarioId: "infra-one", outcome: "infrastructure_error" })))).toBe(false);
  });

  test("freshSession is part of the resume key", () => {
    const root = tmp();
    const store = new ResultStore(root, "run1");
    const same = rec({ freshSession: false });
    store.record(same);
    expect(store.isCompleted(trialKey(rec({ freshSession: true })))).toBe(false);
  });

  test("summary writes atomically and manifest is write-once", () => {
    const root = tmp();
    const store = new ResultStore(root, "run1");
    store.writeManifest({ v: 1 });
    store.writeManifest({ v: 2 }); // ignored on an existing manifest
    store.writeSummary({ ok: true });
    expect(JSON.parse(readFileSync(join(root, "run1", "manifest.json"), "utf8")).v).toBe(1);
    expect(existsSync(join(root, "run1", "summary.json"))).toBe(true);
  });
});
