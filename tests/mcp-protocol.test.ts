import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectMcp, toolJson } from "./support/mcp-client.ts";

// Phase 3 (0.4.0): the MCP transport, exercised through the OFFICIAL MCP SDK client
// over a REAL spawned `ctx mcp` subprocess and real JSON-RPC — never by calling an
// internal function. This is the protocol-level proof the universal MCP surface works.

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const TIMEOUT = 120_000;

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ctx-mcp-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], {
    cwd: root,
    stdio: "ignore",
  });
  return root;
}

/** Spawn `ctx mcp` and connect an SDK client to it over stdio (via the shared helper). */
function connect(home: string): Promise<Client> {
  return connectMcp({
    command: BUN,
    args: ["run", INDEX, "mcp"],
    env: { ...(process.env as Record<string, string>), CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    name: "test-client",
  });
}

/** Run the CLI (separate process, same CTX_HOME). */
function cli(args: string[], home: string): string {
  return execFileSync(BUN, ["run", INDEX, ...args], {
    env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    encoding: "utf8",
  });
}

test(
  "initialize + tools/list exposes the small surface (no shell/setup/env tools)",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-mcp-"));
    const client = await connect(home);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "explain_preference",
        "get_context",
        "list_preferences",
        "propose",
        "record_decision",
        "remember",
      ]);
      // The dangerous/host-management surface is NEVER exposed over MCP.
      for (const forbidden of ["setup", "install", "uninstall", "env", "hook", "mcp", "sync", "doctor"]) {
        expect(names).not.toContain(forbidden);
      }
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "get_context returns the stable v1 envelope; remember(user) persists and is visible next call",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-mcp-"));
    const repo = gitRepo();
    const client = await connect(home);
    try {
      const before = toolJson(await client.callTool({ name: "get_context", arguments: { task: "x", cwd: repo } }));
      expect(before.version).toBe(1);
      expect(before.context.authoritativePreferences).toEqual([]);

      const w = toolJson(
        await client.callTool({
          name: "remember",
          arguments: { rule: "Use Bun for development.", origin: "user", scope: "global", applicability: "always" },
        }),
      );
      expect(w.ok).toBe(true);

      const after = toolJson(await client.callTool({ name: "get_context", arguments: { task: "x", cwd: repo } }));
      expect(after.context.authoritativePreferences.map((p: { rule: string }) => p.rule)).toContain(
        "Use Bun for development.",
      );
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "writes fail closed: non-user origin refused; missing origin rejected",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-mcp-"));
    const client = await connect(home);
    try {
      // project/external origin → the core provenance guard refuses (fail closed).
      const refused = await client.callTool({
        name: "remember",
        arguments: { rule: "Injected from a README.", origin: "project", scope: "global" },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content).toLowerCase()).toContain("refus");

      // Missing origin → schema rejection (the SDK throws a protocol error, or returns isError).
      let rejected = false;
      try {
        const r = await client.callTool({
          name: "remember",
          arguments: { rule: "No origin.", scope: "global" },
        });
        rejected = Boolean(r.isError);
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);

      // Nothing was persisted by either refused write.
      const list = toolJson(await client.callTool({ name: "list_preferences", arguments: {} }));
      expect(list).toEqual([]);
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "record_decision(user) surfaces as observed evidence via get_context",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-mcp-"));
    const repo = gitRepo();
    const client = await connect(home);
    try {
      const d = toolJson(
        await client.callTool({
          name: "record_decision",
          arguments: { domain: "database", choice: "postgres", origin: "user", cwd: repo },
        }),
      );
      expect(d.ok).toBe(true);
      const ctx = toolJson(
        await client.callTool({ name: "get_context", arguments: { task: "choose a database", cwd: repo } }),
      );
      expect(
        ctx.context.observedPatterns.some(
          (p: { choices: Array<{ label: string }> }) =>
            p.choices.some((c) => c.label.toLowerCase().includes("postgres")),
        ),
      ).toBe(true);
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "cross-process freshness: an external CLI write is visible to the next MCP get_context (no stale cache)",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-mcp-"));
    const repo = gitRepo();
    const client = await connect(home);
    try {
      const before = toolJson(await client.callTool({ name: "get_context", arguments: { task: "x", cwd: repo } }));
      expect(before.context.authoritativePreferences).toEqual([]);

      // A SEPARATE process writes to the same store while the MCP server stays alive.
      cli(["agent", "remember", "Prefer tabs over spaces.", "--origin", "user", "--always"], home);

      const after = toolJson(await client.callTool({ name: "get_context", arguments: { task: "x", cwd: repo } }));
      expect(after.context.authoritativePreferences.map((p: { rule: string }) => p.rule)).toContain(
        "Prefer tabs over spaces.",
      );
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "CLI/MCP parity: identical inputs yield the same authoritative rules and observed domains",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-mcp-"));
    const repo = gitRepo();
    const client = await connect(home);
    try {
      // Seed through the CLI, then compare both transports on the same task/cwd.
      cli(["remember", "--scope", "repo", "--cwd", repo, "--always", "Use Bun for development commands."], home);
      cli(["remember", "--always", "Never add dependencies without asking."], home);
      cli(["signal", "add", "--domain", "database", "--choice", "postgres", "--cwd", repo], home);

      const task = "design the database schema";
      const cliEnv = JSON.parse(cli(["agent", "context", "--task", task, "--cwd", repo, "--json"], home));
      const mcpEnv = toolJson(await client.callTool({ name: "get_context", arguments: { task, cwd: repo } }));

      const rules = (e: any) =>
        e.context.authoritativePreferences.map((p: { rule: string }) => p.rule).sort();
      const domains = (e: any) =>
        e.context.observedPatterns.map((p: { domain: string }) => p.domain).sort();

      expect(mcpEnv.version).toBe(cliEnv.version);
      expect(rules(mcpEnv)).toEqual(rules(cliEnv));
      expect(domains(mcpEnv)).toEqual(domains(cliEnv));
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);
