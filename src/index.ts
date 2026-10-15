#!/usr/bin/env bun
import { runCli } from "./cli/index.ts";

// Fail gracefully when a downstream pipe closes early (e.g. `ctx prefs | head`).
// Without this, Node/Bun raise an EPIPE and dump a stack trace.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});
process.stderr.on("error", () => {
  /* ignore */
});

/**
 * Split argv on the first command separator so that
 * `ctx env run <envs> -- <cmd>` passes an arbitrary command through untouched.
 *
 * Two separators are accepted:
 *   `--`      standard POSIX (bash/zsh/sh).
 *   `--exec`  PowerShell-safe: PowerShell strips a bare `--`, so Windows users
 *             pass the command after `--exec` instead.
 */
function splitArgv(argv: string[]): { main: string[]; passthrough: string[] | null } {
  const idx = argv.findIndex((a) => a === "--" || a === "--exec");
  if (idx === -1) return { main: argv, passthrough: null };
  return { main: argv.slice(0, idx), passthrough: argv.slice(idx + 1) };
}

const { main, passthrough } = splitArgv(process.argv.slice(2));

// Bare `ctx` in an interactive terminal opens the TUI (spec §2). Every other case —
// any subcommand/flag, a `--`/`--exec` passthrough, a non-TTY (pipe/script/CI/MCP), or
// CTX_NO_TUI — falls through to the CLI, so redirected output never sees a TUI escape.
// The TUI module is imported LAZILY so normal CLI invocations never load it.
const { shouldLaunchTui } = await import("./tui/launch.ts");
if (
  shouldLaunchTui({
    args: main,
    hasPassthrough: passthrough !== null,
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  })
) {
  const { runTui } = await import("./tui/app.ts");
  await runTui(process.env);
} else {
  await runCli(main, { passthrough });
}
