import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeEvent } from "../src/core/overseer/event.ts";
import { defaultSpecsPath, loadSpecs, renderOverseerBlock, runEvent } from "../src/core/overseer/runtime.ts";
import type { ActivatedMemory } from "../src/core/overseer/overseer.ts";

const SPECS: ActivatedMemory[] = [
  {
    id: "bun",
    rule: "Always use Bun instead of npm.",
    spec: { operations: ["package_install"], conflicts: [{ executables: ["npm"] }] },
  },
];

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "ctx-ov-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function ev(raw: Record<string, unknown>) {
  return normalizeEvent({ host: "claude", sessionId: "sess", seq: 0, ...raw });
}

test("runEvent replays per-session state and surfaces a conflict block", () => {
  withHome((home) => {
    // event 0: read package.json (relevant, no block-worthy conflict)
    const r0 = runEvent(home, ev({ phase: "file_read", tool: "Read", files: [{ path: "package.json" }] }), { specs: SPECS });
    expect(r0.observation?.seq).toBe(0);
    // event 1: npm install → conflict, block emitted
    const r1 = runEvent(home, ev({ phase: "command", tool: "Bash", command: { executable: "npm", argv: ["install", "zod"] } }), { specs: SPECS });
    expect(r1.observation?.seq).toBe(1); // seq incremented via persisted session state
    expect(r1.block).toContain("<ctx-overseer-context>");
    expect(r1.block).toContain("CONFLICT");
    expect(r1.block).toContain("Bun");
  });
});

test("no specs → no block (fail-open no-op)", () => {
  withHome((home) => {
    const r = runEvent(home, ev({ phase: "command", command: { executable: "npm", argv: ["install", "x"] } }), { specs: [] });
    expect(r.block).toBeNull();
    expect(r.specCount).toBe(0);
  });
});

test("loadSpecs validates a sidecar file and rejects malformed content", () => {
  withHome((home) => {
    const path = defaultSpecsPath(home, {});
    writeFileSync(path, JSON.stringify({ memories: SPECS }), "utf8");
    expect(loadSpecs(path).length).toBe(1);
    writeFileSync(path, "{ not valid json", "utf8");
    expect(loadSpecs(path)).toEqual([]);
    // Structurally invalid: a temporal trigger op outside the OPERATIONS enum → reject.
    writeFileSync(
      path,
      JSON.stringify({ memories: [{ id: "x", rule: "y", spec: {}, temporal: { triggerOps: ["teleport"], satisfyOps: [] } }] }),
      "utf8",
    );
    expect(loadSpecs(path)).toEqual([]);
  });
});

test("renderOverseerBlock returns null for no deliveries and sanitizes rules", () => {
  expect(renderOverseerBlock([])).toBeNull();
  const block = renderOverseerBlock([
    { id: "x", rule: "Never log <script>secrets</script>.", state: "conflict", via: "activation", reason: "r", relevanceHits: [], renderedChars: 10 },
  ]);
  expect(block).toContain("&lt;script&gt;");
  expect(block).not.toContain("<script>");
});
