import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE RELEASE-DEFINING TEST (spec §48/§49).
//
// A completely unknown "fake agent" with ZERO goatedcontext-specific adapter code,
// using ONLY the documented universal interface. This file imports NO goatedcontext
// internal module — only node built-ins, the `ctx` binary as a SUBPROCESS, and the
// standard MCP SDK client. If the memory behavior matches Claude/Codex/Cursor, the
// universal architecture is real.
// ─────────────────────────────────────────────────────────────────────────────

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const TIMEOUT = 120_000;

/** The ONLY thing the fake CLI agent knows how to do: run `ctx` as a subprocess. */
function ctx(args: string[], home: string, stdin?: string): string {
  return execFileSync(BUN, ["run", INDEX, ...args], {
    env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    input: stdin,
    encoding: "utf8",
  });
}

function repo(remoteSlug: string): string {
  const root = mkdtempSync(join(tmpdir(), "ctx-any-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${remoteSlug}.git`], {
    cwd: root,
    stdio: "ignore",
  });
  return root;
}

test(
  "§48 CLI: unknown agent records cross-repo decisions and a user preference, both resurface in fresh repos",
  () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-any-cli-"));
    const repoA = repo("a");
    const repoB = repo("b");
    const repoC = repo("c");
    const repoD = repo("d");
    try {
      // Repos A and B: the user picks Postgres. The fake agent records it via the generic
      // write surface (no branded adapter). Distinct repos → cross-repo breadth.
      ctx(["agent", "signal", "add", "--origin", "user", "--domain", "database", "--choice", "postgres", "--cwd", repoA], home);
      ctx(["agent", "signal", "add", "--origin", "user", "--domain", "database", "--choice", "postgres", "--cwd", repoB], home);

      // Repo C (fresh): the fake agent asks via --stdin --json, shell-escaping NOTHING.
      const cEnv = JSON.parse(
        ctx(["agent", "context", "--stdin", "--json"], home, JSON.stringify({ task: "what database should I pick?", cwd: repoC })),
      );
      const dbPattern = cEnv.context.observedPatterns.find((p: { domain: string }) => p.domain === "database");
      expect(dbPattern).toBeTruthy();
      expect(dbPattern.choices.some((c: { label: string }) => c.label.toLowerCase().includes("postgres"))).toBe(true);

      // The user expresses a durable preference. The fake agent persists it generically.
      ctx(["agent", "remember", "Prefer TypeScript over JavaScript.", "--origin", "user", "--scope", "global", "--always"], home);

      // Repo D (fresh): the preference is authoritative context everywhere.
      const dEnv = JSON.parse(
        ctx(["agent", "context", "--stdin", "--json"], home, JSON.stringify({ task: "start a new service", cwd: repoD })),
      );
      expect(dEnv.context.authoritativePreferences.map((p: { rule: string }) => p.rule)).toContain(
        "Prefer TypeScript over JavaScript.",
      );
    } finally {
      for (const d of [home, repoA, repoB, repoC, repoD]) rmSync(d, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "§49 MCP: the SAME scenario over a standard MCP client yields identical memory behavior",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-any-mcp-"));
    const repoA = repo("ma");
    const repoB = repo("mb");
    const repoC = repo("mc");
    const repoD = repo("md");
    const transport = new StdioClientTransport({
      command: BUN,
      args: ["run", INDEX, "mcp"],
      env: { ...(process.env as Record<string, string>), CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    });
    const client = new Client({ name: "unknown-agent", version: "0.0.0" });
    const toolJson = (r: any) => JSON.parse((r.content ?? []).find((c: any) => c.type === "text")?.text ?? "");
    try {
      await client.connect(transport);

      // Standard tools/list — no goatedcontext knowledge needed beyond the tool names.
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("get_context");

      await client.callTool({ name: "record_decision", arguments: { domain: "database", choice: "postgres", origin: "user", cwd: repoA } });
      await client.callTool({ name: "record_decision", arguments: { domain: "database", choice: "postgres", origin: "user", cwd: repoB } });

      const cEnv = toolJson(await client.callTool({ name: "get_context", arguments: { task: "what database should I pick?", cwd: repoC } }));
      const dbPattern = cEnv.context.observedPatterns.find((p: { domain: string }) => p.domain === "database");
      expect(dbPattern).toBeTruthy();
      expect(dbPattern.choices.some((c: { label: string }) => c.label.toLowerCase().includes("postgres"))).toBe(true);

      await client.callTool({
        name: "remember",
        arguments: { rule: "Prefer TypeScript over JavaScript.", origin: "user", scope: "global", applicability: "always" },
      });

      const dEnv = toolJson(await client.callTool({ name: "get_context", arguments: { task: "start a new service", cwd: repoD } }));
      expect(dEnv.context.authoritativePreferences.map((p: { rule: string }) => p.rule)).toContain(
        "Prefer TypeScript over JavaScript.",
      );
    } finally {
      await client.close();
      for (const d of [home, repoA, repoB, repoC, repoD]) rmSync(d, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);
