import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../utils/fs.ts";

/**
 * Cursor MCP server wiring in `~/.cursor/mcp.json` (0.4.0).
 *
 * Verified against current Cursor docs (2026). Schema:
 *   { "mcpServers": { "<name>": { "command": "...", "args": [...], "env"?: {...} } } }
 * We register a single stdio server named `goatedcontext` that runs the INSTALLED,
 * persistent `ctx` launcher (`ctx` / `ctx.cmd`) with `["mcp"]` — never an ephemeral
 * npx cache path and never the repo checkout. This gives Cursor structured, per-task
 * read/write memory tools (the dynamic complement to the sessionStart bootstrap hook).
 *
 * Ownership is surgical: only OUR named server is added/updated/removed; unrelated
 * servers are preserved, and extra keys a user added to our entry (e.g. `env`) survive
 * an update. A present-but-unparseable file is NEVER clobbered (returns "error").
 */

export const CURSOR_MCP_SERVER_NAME = "goatedcontext";

export function cursorMcpFile(home: string): string {
  return join(home, "mcp.json");
}

interface McpEntry {
  command?: string;
  args?: string[];
  [k: string]: unknown;
}

export type CursorMcpAction = "created" | "updated" | "unchanged" | "removed" | "absent" | "error";

function read(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sameInvocation(a: McpEntry | undefined, command: string, args: string[]): boolean {
  return (
    !!a && a.command === command && JSON.stringify(a.args ?? []) === JSON.stringify(args)
  );
}

/** Install/refresh OUR Cursor MCP server entry, preserving all other servers. */
export function upsertCursorMcp(file: string, command: string, args: string[]): CursorMcpAction {
  const settings = read(file);
  if (settings === null) return "error";
  const servers = (settings.mcpServers ??= {}) as Record<string, McpEntry>;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return "error";
  const existing = servers[CURSOR_MCP_SERVER_NAME];
  if (sameInvocation(existing, command, args)) return "unchanged";
  const action: CursorMcpAction = existing ? "updated" : "created";
  // Preserve any extra keys on our entry (e.g. a user-added `env`); own command/args.
  servers[CURSOR_MCP_SERVER_NAME] = { ...(existing ?? {}), command, args };
  writeFileAtomic(file, JSON.stringify(settings, null, 2) + "\n", 0o644);
  return action;
}

/** Remove ONLY our Cursor MCP server entry, keeping unrelated servers intact. */
export function removeCursorMcp(file: string): CursorMcpAction {
  const settings = read(file);
  if (settings === null) return "error";
  const servers = settings.mcpServers as Record<string, McpEntry> | undefined;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return "absent";
  if (!(CURSOR_MCP_SERVER_NAME in servers)) return "absent";
  delete servers[CURSOR_MCP_SERVER_NAME];
  writeFileAtomic(file, JSON.stringify(settings, null, 2) + "\n", 0o644);
  return "removed";
}

/** Whether our Cursor MCP server entry is currently configured. */
export function detectCursorMcp(file: string): boolean {
  const settings = read(file);
  if (!settings) return false;
  const servers = (settings as { mcpServers?: Record<string, unknown> }).mcpServers;
  return !!servers && typeof servers === "object" && !Array.isArray(servers) && CURSOR_MCP_SERVER_NAME in servers;
}
