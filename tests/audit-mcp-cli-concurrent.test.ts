import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMcp, toolJson } from "./support/mcp-client.ts";

/**
 * MCP + CLI simultaneous access (audit §6): a live MCP server and concurrent CLI writers
 * share one SQLite store under WAL. Reads stay consistent, writes don't corrupt, and the
 * MCP server observes committed CLI writes on its next call (no cache).
 */

const BUN = process.execPath;
const INDEX = join(import.meta.dir, "..", "src", "index.ts");

function cli(args: string[], home: string) {
  const p = Bun.spawn([BUN, "run", INDEX, ...args], {
    cwd: home,
    env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return (async () => ({ code: await p.exited }))();
}

test(
  "MCP server + concurrent CLI writers: no corruption, MCP sees committed writes",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-mcpcli-"));
    try {
      await cli(["init"], home);
      const client = await connectMcp({
        command: BUN,
        args: ["run", INDEX, "mcp"],
        env: { ...(process.env as Record<string, string>), CTX_HOME: home, CTX_SECRET_BACKEND: "file" },
      });
      try {
        // Fire CLI writers while repeatedly calling MCP reads/writes concurrently.
        const writers = Array.from({ length: 8 }, (_, i) =>
          cli(["remember", `Always honor rule number ${i} precisely.`, "--scope", "global", "--always"], home),
        );
        const mcpCalls = Array.from({ length: 6 }, () =>
          client.callTool({ name: "get_context", arguments: { task: "work" } }),
        );
        const [writerResults] = await Promise.all([Promise.all(writers), Promise.all(mcpCalls)]);
        expect(writerResults.every((r) => r.code === 0)).toBe(true);

        // One more MCP write via the tool, concurrently safe.
        const rem = await client.callTool({
          name: "remember",
          arguments: { rule: "Always verify inputs at the boundary.", origin: "user", scope: "global" },
        });
        expect((rem as { isError?: boolean }).isError).toBeFalsy();

        // MCP observes the committed CLI writes (no stale cache).
        const ctxRes = await client.callTool({ name: "get_context", arguments: { task: "work" } });
        const env = toolJson(ctxRes);
        const rules = (env.context.authoritativePreferences as Array<{ rule: string }>).map((p) => p.rule);
        expect(rules.some((r) => /honor rule number/i.test(r))).toBe(true);

        // DB integrity intact after concurrent access.
        const list = JSON.parse((await (async () => {
          const p = Bun.spawn([BUN, "run", INDEX, "prefs", "--json"], {
            cwd: home, env: { ...process.env, CTX_HOME: home, CTX_SECRET_BACKEND: "file" }, stdout: "pipe", stderr: "pipe",
          });
          const out = await new Response(p.stdout).text();
          await p.exited;
          return out;
        })()));
        // 8 CLI always-rules (distinct subjects) + 1 MCP rule, all present, no dupes/corruption.
        expect(list.filter((p: { rule: string }) => /honor rule number/i.test(p.rule)).length).toBe(8);
      } finally {
        await client.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  90_000,
);
