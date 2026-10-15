/**
 * The pure routing decision for bare `ctx` (spec §2). Isolated here so it can be tested
 * exhaustively without a terminal: the TUI launches ONLY when there is no subcommand/
 * flag, no `--`/`--exec` passthrough, both stdin and stdout are interactive TTYs, and
 * the escape hatch `CTX_NO_TUI` is unset. Any other case falls through to the existing
 * CLI, so pipes, scripts, CI, MCP and redirected output never see a TUI escape code.
 */
export interface LaunchInputs {
  /** The main argv after the entry point split off any `--`/`--exec` passthrough. */
  args: string[];
  stdinTTY: boolean;
  stdoutTTY: boolean;
  env: NodeJS.ProcessEnv;
  /** Whether a `--`/`--exec` passthrough separator was present. */
  hasPassthrough: boolean;
}

export function shouldLaunchTui(i: LaunchInputs): boolean {
  if (i.env.CTX_NO_TUI && i.env.CTX_NO_TUI.length > 0) return false;
  if (i.hasPassthrough) return false;
  if (i.args.length > 0) return false;
  if (!i.stdinTTY || !i.stdoutTTY) return false;
  return true;
}
