// Shared MCP client helper (repo-only; NOT shipped). The one place protocol setup
// lives: both the MCP tests and the `smoke:mcp` script connect through the OFFICIAL
// @modelcontextprotocol/sdk client here, so no raw JSON-RPC frame and no hard-coded
// protocolVersion is hand-built anywhere. Protocol version negotiation is the SDK's job.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpConnectOptions {
  /** Executable to spawn the MCP server (e.g. the node binary, or an installed `ctx`). */
  command: string;
  /** Args that launch `... mcp` (e.g. ["path/to/dist/index.js", "mcp"] or ["mcp"]). */
  args: string[];
  /** Environment for the server process (CTX_HOME etc.). */
  env?: Record<string, string>;
  /** Client display name. */
  name?: string;
}

/** Spawn an MCP server over stdio and return a connected SDK client. */
export async function connectMcp(opts: McpConnectOptions): Promise<Client> {
  const transport = new StdioClientTransport({
    command: opts.command,
    args: opts.args,
    env: opts.env,
  });
  const client = new Client({ name: opts.name ?? "ctx-mcp-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Parse the first text block of a tool result as JSON (the ctx machine payload). */
export function toolJson(res: unknown): any {
  const content = ((res as { content?: Array<{ type: string; text?: string }> }).content ?? []);
  const text = content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text);
}
