#!/usr/bin/env bun
/**
 * MCP smoke test (maintainer/repo command): verify the MCP server end-to-end through the
 * OFFICIAL @modelcontextprotocol/sdk client — never hand-built JSON-RPC, never a
 * hard-coded protocol version (the SDK negotiates that).
 *
 *   bun run smoke:mcp                 # validates the shipped bundle: `node dist/index.js mcp`
 *   CTX_SMOKE_CMD=ctx bun run smoke:mcp   # post-publish: validate an INSTALLED launcher
 *
 * This is a Bun-run repository command. It does NOT make installed users depend on Bun:
 * the published `ctx mcp` runs on Node from the self-contained bundle, which is exactly
 * what the default path here exercises.
 *
 * Steps: seed a known preference + signal via the SAME ctx binary (a separate process),
 * then over MCP: initialize, tools/list, get_context (must reflect the seeded write),
 * and shut the client/server down cleanly.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whichSync } from "../../src/utils/runtime.ts";
import { connectMcp, toolJson } from "../../tests/support/mcp-client.ts";

const ROOT = join(import.meta.dirname, "..", "..");

/** The ctx launcher to validate: an explicit installed binary, else the shipped Node bundle. */
function resolveLaunch(): { command: string; args: string[] } {
  const explicit = process.env.CTX_SMOKE_CMD;
  if (explicit && explicit.trim()) return { command: explicit.trim(), args: [] };
  const node = whichSync("node");
  if (!node) throw new Error("node not found on PATH");
  const dist = join(ROOT, "dist", "index.js");
  if (!existsSync(dist)) throw new Error("dist/index.js missing — run `bun run build` first");
  return { command: node, args: [dist] };
}

async function main(): Promise<void> {
  const { command, args } = resolveLaunch();
  const home = mkdtempSync(join(tmpdir(), "ctx-smoke-mcp-"));
  const env = { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" } as Record<string, string>;
  const log = (m: string) => process.stdout.write(m + "\n");
  let client: Awaited<ReturnType<typeof connectMcp>> | undefined;
  let ok = false;
  try {
    // Seed a known preference + decision signal through the SAME binary (separate process).
    execFileSync(command, [...args, "agent", "remember", "Use Bun for development.", "--origin", "user", "--always"], { env, stdio: "ignore" });
    execFileSync(command, [...args, "agent", "signal", "add", "--origin", "user", "--domain", "database", "--choice", "postgres", "--no-repo"], { env, stdio: "ignore" });

    // initialize + tools/list via the SDK.
    client = await connectMcp({ command, args: [...args, "mcp"], env, name: "ctx-smoke" });
    log("1. initialize: ok");
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    log(`2. tools/list: ${names.join(", ")}`);
    if (!names.includes("get_context")) throw new Error("get_context missing from tools/list");

    // get_context must reflect the seeded preference and surface the seeded decision.
    const envelope = toolJson(await client.callTool({ name: "get_context", arguments: { task: "what database should I use?" } }));
    if (envelope.version !== 1) throw new Error(`unexpected envelope version: ${envelope.version}`);
    const rules = envelope.context.authoritativePreferences.map((p: { rule: string }) => p.rule);
    if (!rules.includes("Use Bun for development.")) throw new Error("get_context did not reflect the CLI-written preference");
    const db = envelope.context.observedPatterns.find((p: { domain: string }) => p.domain === "database");
    if (!db) throw new Error("get_context did not surface the CLI-written decision signal");
    log("3. get_context: reflects CLI-written preference + signal");

    ok = true;
  } finally {
    if (client) await client.close(); // clean client + server shutdown
    rmSync(home, { recursive: true, force: true });
  }
  log(ok ? "SMOKE PASS" : "SMOKE FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`smoke error: ${(e as Error).message}\n`);
  process.exit(1);
});
