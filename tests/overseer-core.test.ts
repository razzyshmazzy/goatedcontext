import { test, expect } from "bun:test";
import { normalizeEvent, type AgentEvent } from "../src/core/overseer/event.ts";
import { Overseer, type ActivatedMemory } from "../src/core/overseer/overseer.ts";
import { CandidateIndex } from "../src/core/overseer/candidate-index.ts";
import { extractFeatures } from "../src/core/overseer/features.ts";
import { WorkflowState } from "../src/core/overseer/workflow-state.ts";

function ev(seq: number, raw: Record<string, unknown>): AgentEvent {
  return normalizeEvent({ host: "claude", sessionId: "s", seq, ...raw });
}

const bun: ActivatedMemory = {
  id: "bun",
  rule: "Always use Bun instead of npm.",
  spec: {
    domains: ["package-manager"],
    operations: ["package_install", "package_remove"],
    conflicts: [{ executables: ["npm", "yarn", "pnpm"] }],
  },
};

const migration: ActivatedMemory = {
  id: "mig",
  rule: "Run tests after changing database migrations.",
  spec: { artifacts: ["migration"], operations: ["migration_edit", "migration_run"] },
  temporal: { triggerOps: ["migration_edit", "migration_run"], satisfyOps: ["test_run"] },
};

test("candidate index narrows to relevant memories by feature", () => {
  const idx = new CandidateIndex();
  idx.add("bun", bun.spec);
  idx.add("mig", migration.spec);
  const f = extractFeatures(ev(0, { phase: "command", command: { executable: "npm", argv: ["install", "x"] } }));
  const cands = idx.candidates(f);
  expect(cands.has("bun")).toBe(true);
  expect(cands.has("mig")).toBe(false);
});

test("relevant memory is delivered once, then suppressed", () => {
  const o = new Overseer([bun]);
  const d0 = o.observe(ev(0, { phase: "file_read", tool: "Read", files: [{ path: "package.json" }] }));
  expect(d0.deliveries.map((d) => d.id)).toContain("bun");
  const d1 = o.observe(ev(1, { phase: "file_read", tool: "Read", files: [{ path: "package.json" }] }));
  expect(d1.deliveries.length).toBe(0); // already delivered as relevant → suppressed
});

test("a newly-appearing conflict re-surfaces even after a prior relevant delivery", () => {
  const o = new Overseer([bun]);
  o.observe(ev(0, { phase: "file_read", tool: "Read", files: [{ path: "package.json" }] }));
  const conflict = o.observe(ev(1, { phase: "command", command: { executable: "npm", argv: ["install", "zod"] } }));
  const d = conflict.deliveries.find((x) => x.id === "bun");
  expect(d?.state).toBe("conflict");
});

test("temporal obligation: unresolved at stop fires a conflict reminder", () => {
  const o = new Overseer([migration]);
  o.observe(ev(0, { phase: "file_write", tool: "Edit", files: [{ path: "db/migrations/1.sql" }] }));
  const atStop = o.observe(ev(1, { phase: "stop" }));
  const reminder = atStop.deliveries.find((d) => d.id === "mig" && d.state === "conflict");
  expect(reminder).toBeDefined();
  expect(reminder?.via).toBe("temporal");
});

test("temporal obligation: satisfied by a test run → no reminder at stop", () => {
  const o = new Overseer([migration]);
  o.observe(ev(0, { phase: "file_write", tool: "Edit", files: [{ path: "db/migrations/1.sql" }] }));
  o.observe(ev(1, { phase: "command", command: { executable: "bun", argv: ["run", "test"] } }));
  const atStop = o.observe(ev(2, { phase: "stop" }));
  expect(atStop.deliveries.some((d) => d.id === "mig" && d.state === "conflict")).toBe(false);
});

test("repo-scoped memory does not apply outside its repo", () => {
  const scoped: ActivatedMemory = { ...bun, id: "bun-scoped", spec: { ...bun.spec, repo: "remote:github.com/acme/x" } };
  const out = new Overseer([scoped], { currentRepo: "remote:github.com/other/y" });
  const d = out.observe(ev(0, { phase: "command", command: { executable: "npm", argv: ["install", "x"] } }));
  expect(d.deliveries.length).toBe(0);
  const inRepo = new Overseer([scoped], { currentRepo: "remote:github.com/acme/x" });
  expect(inRepo.observe(ev(0, { phase: "command", command: { executable: "npm", argv: ["install", "x"] } })).deliveries.length).toBe(1);
});

test("observing events never mutates the input memories (no persistence from events, §26)", () => {
  const snapshot = JSON.stringify(bun);
  const o = new Overseer([bun]);
  o.observe(ev(0, { phase: "command", command: { executable: "npm", argv: ["install", "x"] } }));
  expect(JSON.stringify(bun)).toBe(snapshot);
});

test("workflow state is bounded and decays", () => {
  const ws = new WorkflowState({ historyLimit: 3, useDecay: true, decayLambda: 0.5, decayDelta: 1, decayThreshold: 0.3 });
  for (let i = 0; i < 6; i++) ws.observe(extractFeatures(ev(i, { phase: "command", command: { executable: "psql", argv: ["db"] } })));
  const snap = ws.snapshot();
  expect(snap.recentDomains.length).toBeLessThanOrEqual(3);
  expect(ws.activationOf("database")).toBeGreaterThan(0);
  // A domain never seen again decays toward zero.
  for (let i = 6; i < 12; i++) ws.observe(extractFeatures(ev(i, { phase: "file_read", tool: "Read", files: [{ path: "README.md" }] })));
  expect(ws.activationOf("database")).toBeLessThan(0.3);
});

test("decay path activates a same-domain memory on a later event without a direct hit", () => {
  // A memory that ONLY has a domain dimension (no op/exe), so a stateless match on a
  // non-PM event would miss it; the decay field should still activate it.
  const dbMem: ActivatedMemory = { id: "pg", rule: "Prefer Postgres.", spec: { domains: ["database"] } };
  const stateless = new Overseer([dbMem], { config: { useWorkflowState: false, useDecay: false } });
  const withDecay = new Overseer([dbMem], { config: { useWorkflowState: true, useDecay: true } });
  const dbEvent = ev(0, { phase: "command", command: { executable: "psql", argv: ["app"] } });
  // event 1 is unrelated; with decay the db domain is still "warm".
  const unrelated = ev(1, { phase: "file_read", tool: "Read", files: [{ path: "src/utils/x.ts" }] });
  stateless.observe(dbEvent);
  const s1 = stateless.observe(unrelated);
  expect(s1.deliveries.length).toBe(0);
  withDecay.observe(dbEvent); // delivers pg once (relevant via domain)
  const w1 = withDecay.observe(unrelated);
  // pg already delivered relevant at event 0, so it is suppressed at event 1 — but it
  // WAS a candidate via decay. Assert the decay candidate path is exercised.
  expect(w1.candidates).toContain("pg");
});
