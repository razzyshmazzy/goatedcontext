/**
 * The UNIVERSAL agent interfaces (0.4.0).
 *
 * These are agent-NEUTRAL transports that any agent can use after
 * `npx goatedcontext setup`, with NO goatedcontext code change required to support a
 * new agent — as long as that agent can speak MCP, invoke a subprocess, or read a
 * static file. They are distinct from the NATIVE integrations (Claude Code, Codex,
 * Cursor), which are zero-config optimizations layered on top of the same core.
 *
 * This descriptor is for display/inspection (`ctx agents`, docs). It intentionally
 * reports the interfaces ctx PROVIDES — not a claim that any particular unknown agent
 * is "connected" (it is the agent's choice to use one of these).
 */
export interface UniversalInterface {
  id: "mcp" | "cli" | "agents-md";
  label: string;
  ready: boolean;
  /** How to invoke it (illustrative; the CLI/MCP are provided by the installed `ctx`). */
  invoke: string;
  description: string;
}

export interface UniversalInterfaces {
  mcp: UniversalInterface;
  cli: UniversalInterface;
  agentsMd: UniversalInterface;
}

/**
 * The universal interfaces ctx provides. `command` is the resolved `ctx` launcher name
 * for display (e.g. "ctx" or "ctx.cmd"). All three are always ready once ctx is
 * installed: the CLI and MCP are the ctx binary itself; AGENTS.md is produced by
 * `ctx sync` per repo.
 */
export function universalInterfaces(command = "ctx"): UniversalInterfaces {
  return {
    mcp: {
      id: "mcp",
      label: "MCP",
      ready: true,
      invoke: `${command} mcp`,
      description: "stdio MCP server: get_context + memory write tools for any MCP-capable agent",
    },
    cli: {
      id: "cli",
      label: "Agent CLI",
      ready: true,
      invoke: `${command} agent context --json`,
      description: "subprocess retrieval (stable JSON envelope) + ctx agent memory writes",
    },
    agentsMd: {
      id: "agents-md",
      label: "AGENTS.md",
      ready: true,
      invoke: `${command} sync`,
      description: "repo-scoped static projection (approved/locked always-rules only)",
    },
  };
}
