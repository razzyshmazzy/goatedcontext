#!/usr/bin/env bun
import { runCli } from "./cli/index.ts";

/**
 * Split argv on the first standalone `--` so that `ctx env run <envs> -- <cmd>`
 * can pass an arbitrary command through untouched, without commander trying to
 * interpret the command's own flags.
 */
function splitArgv(argv: string[]): { main: string[]; passthrough: string[] | null } {
  const idx = argv.indexOf("--");
  if (idx === -1) return { main: argv, passthrough: null };
  return { main: argv.slice(0, idx), passthrough: argv.slice(idx + 1) };
}

const { main, passthrough } = splitArgv(process.argv.slice(2));

await runCli(main, { passthrough });
