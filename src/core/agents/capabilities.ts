/**
 * Agent capability model (0.2.9).
 *
 * Each supported agent is described by a small, explicit set of capabilities that
 * core behavior (the delivery planner, `ctx agents`, `ctx doctor`, `ctx test-hook`)
 * consults INSTEAD of scattering `if (agent === "codex")` checks around the code.
 * The fields answer concrete integration questions, populated from the real,
 * audited integration surfaces — nothing aspirational.
 */

export type AgentId = "claude" | "codex" | "cursor";
export const AGENT_IDS: AgentId[] = ["claude", "codex", "cursor"];

export interface AgentCapabilities {
  /** Can the agent inject context at prompt time via a hook we control? */
  runtimePromptInjection: boolean;
  /** Does the agent read a repo-root `AGENTS.md` we can project into? */
  staticAgentsMd: boolean;
  /** Does our integration use `.cursor/rules/*.mdc`? (We prefer AGENTS.md; see docs.) */
  staticCursorRules: boolean;
  /** Does the runtime hook payload expose the working directory? */
  cwdAvailable: boolean;
  /** Does the runtime hook payload expose the user's prompt text? */
  promptAvailable: boolean;
  /** Does the runtime hook payload expose active file context? */
  fileContextAvailable: boolean;
  /** Does the agent support once-per-session context injection? */
  sessionInjection: boolean;
  /** Can we install a native skill teaching the ctx memory-WRITE protocol? */
  memorySkill: boolean;
  // ---- 0.4.0 universal-transport capabilities (additive) --------------------
  /** Does ctx install a native runtime HOOK for this agent (prompt- or session-level)? */
  nativeHooks: boolean;
  /** Does ctx natively configure this agent to use the ctx MCP server (stdio)? */
  mcp: boolean;
  /** Does ctx install host permission rules so agent memory writes are seamless? */
  permissionIntegration: boolean;
}

/**
 * Claude Code: a `UserPromptSubmit` hook injects plain stdout; payload carries
 * `cwd` + `prompt` but no active file. We do NOT project preferences into a Claude
 * static file — Claude's standing rules are delivered at runtime by the hook (its
 * `CLAUDE.md` block is meta-instructions, not a preference projection).
 */
export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  runtimePromptInjection: true,
  staticAgentsMd: false,
  staticCursorRules: false,
  cwdAvailable: true,
  promptAvailable: true,
  fileContextAvailable: false,
  sessionInjection: false,
  memorySkill: true,
  nativeHooks: true,
  mcp: false, // Claude Code supports MCP, but ctx does not auto-configure it (hook-native)
  permissionIntegration: true,
};

/**
 * OpenAI Codex: reads `AGENTS.md` (static) AND runs a `UserPromptSubmit` hook
 * (runtime, plain stdout). Payload carries `cwd` + `prompt`, no active file.
 */
export const CODEX_CAPABILITIES: AgentCapabilities = {
  runtimePromptInjection: true,
  staticAgentsMd: true,
  staticCursorRules: false,
  cwdAvailable: true,
  promptAvailable: true,
  fileContextAvailable: false,
  sessionInjection: false,
  memorySkill: true,
  nativeHooks: true,
  mcp: false, // Codex supports MCP, but ctx is hook-native here
  permissionIntegration: true,
};

/**
 * Cursor: reads `AGENTS.md` (static). Has NO reliable prompt-time context
 * injection — `beforeSubmitPrompt` is block-only and `sessionStart.additional_context`
 * is a confirmed bug — so runtime injection is false. We deliver via AGENTS.md only
 * (`.cursor/rules` would add nothing for always-on rules), so `staticCursorRules`
 * is false by design.
 */
export const CURSOR_CAPABILITIES: AgentCapabilities = {
  // `beforeSubmitPrompt` cannot inject per-prompt context (block-only), so prompt-time
  // injection stays false. Session-level injection + MCP are wired in 0.4.0 (below).
  runtimePromptInjection: false,
  staticAgentsMd: true,
  staticCursorRules: false,
  cwdAvailable: false,
  promptAvailable: false,
  // A `sessionStart` hook CAN return `additional_context` (verified, local editor), so
  // once-per-session bootstrap injection is supported; per-prompt retrieval is via MCP.
  sessionInjection: true,
  fileContextAvailable: false,
  memorySkill: true,
  nativeHooks: true, // ~/.cursor/hooks.json sessionStart (0.4.0)
  mcp: true, // ~/.cursor/mcp.json stdio goatedcontext server (0.4.0)
  permissionIntegration: false, // Cursor terminal allowlist is injection-unsafe; use MCP instead
};

/**
 * The capability profile of a plain `AGENTS.md` FILE (not an agent): a static,
 * prompt-independent sink with no runtime injection. The static materializer uses
 * this so the file's contents are derived by the SAME delivery planner that decides
 * every other routing — a single source of policy truth.
 */
export const AGENTS_FILE_CAPABILITIES: AgentCapabilities = {
  runtimePromptInjection: false,
  staticAgentsMd: true,
  staticCursorRules: false,
  cwdAvailable: false,
  promptAvailable: false,
  fileContextAvailable: false,
  sessionInjection: false,
  memorySkill: false,
  nativeHooks: false,
  mcp: false,
  permissionIntegration: false,
};

export function capabilitiesFor(id: AgentId): AgentCapabilities {
  switch (id) {
    case "claude":
      return CLAUDE_CAPABILITIES;
    case "codex":
      return CODEX_CAPABILITIES;
    case "cursor":
      return CURSOR_CAPABILITIES;
  }
}
