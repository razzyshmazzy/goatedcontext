import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0.4.0 release-hygiene guards (deterministic, not prose snapshots):
//  1. release/smoke instructions never hand-build MCP JSON-RPC or pin a protocol version
//     (we rely on @modelcontextprotocol/sdk for protocol handling).
//  2. the MCP smoke path is SDK-based and wired into RELEASE.md.
//  3. the memory-bloat benchmark prose reports the measured range, not "cheap".

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const RAW_JSONRPC = /protocolVersion|jsonrpc|notifications\/initialized|2024-11-05/;

test("RELEASE.md contains no raw hand-built MCP JSON-RPC and uses the SDK smoke command", () => {
  const release = read("RELEASE.md");
  expect(RAW_JSONRPC.test(release)).toBe(false);
  expect(release).toContain("smoke:mcp");
  // The stale pre-0.4.0 Cursor claim must be gone.
  expect(release).not.toContain("runtime unavailable");
});

test("the MCP smoke script is SDK-based and builds no raw JSON-RPC frames", () => {
  const smoke = read("scripts/smoke/mcp.ts");
  expect(RAW_JSONRPC.test(smoke)).toBe(false);
  // It goes through the shared SDK client helper (which imports the official SDK).
  expect(smoke).toContain("connectMcp");
  const helper = read("tests/support/mcp-client.ts");
  expect(helper).toContain("@modelcontextprotocol/sdk/client");
});

test("package.json exposes the smoke:mcp script", () => {
  const pkg = JSON.parse(read("package.json"));
  expect(pkg.scripts["smoke:mcp"]).toBeTruthy();
});

test("memory-bloat benchmark prose reports the measured range, not 'cheap'", () => {
  const bench = read("scripts/bench/memory-bloat.ts");
  expect(bench.toLowerCase()).not.toContain("stays cheap");
  // Keeps the honest, measured wording and the pathological finding.
  expect(bench).toContain("0.6–1.3");
  expect(bench).toContain("never silently dropped");
});
