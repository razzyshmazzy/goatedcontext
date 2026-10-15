/**
 * The TUI orchestrator: lifecycle + event loop. It opens a `CtxContext`, builds the
 * view-model, sets up the terminal, and turns each keypress into an action — pure UI
 * actions go through `reduce`, mutations go to the `data.ts` service delegations and
 * then rebuild the view-model. Terminal state is restored on quit, Ctrl-C, signals and
 * exceptions (spec §18) via a single idempotent `finalize`.
 */
import { CtxContext } from "../core/context.ts";
import { CtxError } from "../utils/errors.ts";
import {
  addPreference,
  buildViewModel,
  forgetPreference,
  transitionPreference,
  type BuildOptions,
} from "./data.ts";
import {
  type Action,
  type AppState,
  focusSection,
  initState,
  isEffect,
  reduce,
  resize,
  selectedRow,
  setStatus,
  withViewModel,
} from "./state.ts";
import { decodeKey, keyToAction } from "./input.ts";
import { renderFrame } from "./renderer.ts";
import { createTerminal, type TermIO, type Terminal } from "./terminal.ts";
import { type Theme, detectDepth, makeTheme } from "./theme.ts";

export interface RunTuiOptions {
  /** Inject terminal streams (tests); defaults to process.stdin/stdout. */
  io?: TermIO;
  /** Working directory used to resolve the repo. */
  cwd?: string;
  /** Inject an already-open context (tests); when given, it is NOT closed on exit. */
  ctx?: CtxContext;
  /** Override the theme (tests default to no-color); otherwise detected from the env. */
  theme?: Theme;
}

function computeTheme(env: NodeJS.ProcessEnv, injected: boolean, opts: RunTuiOptions): Theme {
  if (opts.theme) return opts.theme;
  if (injected) return makeTheme(0);
  return makeTheme(detectDepth(env, Boolean(process.stdout.isTTY)));
}

const PAST: Record<string, string> = { approve: "approved", reject: "rejected", lock: "locked" };

export async function runTui(env: NodeJS.ProcessEnv, opts: RunTuiOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const buildOpts: BuildOptions = { cwd, env };

  // Open the store BEFORE touching the terminal, so a DB failure prints a clean error
  // without ever entering raw mode / the alternate screen (spec §18).
  let ctx: CtxContext;
  const ownsCtx = !opts.ctx;
  try {
    ctx = opts.ctx ?? CtxContext.open(env);
  } catch (err) {
    const msg = err instanceof CtxError ? err.message : (err as Error).message;
    process.stderr.write(`ctx: could not open the memory store — ${msg}\n`);
    process.exitCode = 1;
    return;
  }

  // "managed" = driving the REAL process streams. Only then do we touch process-level
  // state (exit code, stderr, signal/exception handlers). With injected streams (tests)
  // the caller owns the process, so we stay side-effect free and never pollute its exit
  // status or install global handlers.
  const managed = !opts.io;
  const io: TermIO = opts.io ?? {
    stdin: process.stdin as unknown as TermIO["stdin"],
    stdout: process.stdout as unknown as TermIO["stdout"],
  };
  const theme = computeTheme(env, Boolean(opts.io), opts);

  let terminal: Terminal;
  try {
    terminal = createTerminal(io);
  } catch (err) {
    if (ownsCtx) ctx.close();
    process.stderr.write(`ctx: could not initialize the terminal — ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  let state: AppState = initState(buildViewModel(ctx, buildOpts), { size: terminal.size(), theme });

  let settled = false;
  let resolveRun: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });

  const signalHandlers: { signal: NodeJS.Signals; handler: () => void }[] = [];
  const onUncaught = (err: unknown) => finalize(err);
  let finalized = false;

  function finalize(err?: unknown): void {
    if (finalized) return;
    finalized = true;
    try {
      terminal.cleanup();
    } catch {
      /* cleanup must never throw */
    }
    for (const { signal, handler } of signalHandlers) process.removeListener(signal, handler);
    process.removeListener("uncaughtException", onUncaught);
    process.removeListener("unhandledRejection", onUncaught);
    if (ownsCtx) {
      try {
        ctx.close();
      } catch {
        /* ignore */
      }
    }
    if (err && managed) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ctx: the interactive UI stopped unexpectedly — ${msg}\n`);
      process.exitCode = 1;
    }
    if (!settled) {
      settled = true;
      resolveRun();
    }
  }

  function render(): void {
    terminal.write(renderFrame(state));
  }

  function rebuild(keepId?: string): void {
    state = withViewModel(state, buildViewModel(ctx, buildOpts), keepId ?? selectedRow(state)?.id);
  }

  function runEffect(action: Action): void {
    try {
      switch (action.type) {
        case "refresh":
          rebuild();
          state = setStatus(state, { text: "Refreshed.", kind: "info" });
          break;
        case "submitAdd": {
          const m = state.modal;
          if (!m || m.type !== "add") break;
          const rule = m.rule.trim();
          if (rule.length === 0) {
            state = setStatus(state, { text: "Rule cannot be empty.", kind: "error" });
            break;
          }
          const pref = addPreference(ctx, { rule, scope: m.scope, cwd });
          state = withViewModel({ ...state, modal: null }, buildViewModel(ctx, buildOpts));
          state = focusSection(state, "preferences");
          state = withViewModel(state, state.vm, pref.id);
          state = setStatus(state, { text: "Added preference.", kind: "info" });
          break;
        }
        case "confirmForget": {
          const m = state.modal;
          if (!m || m.type !== "confirm") break;
          forgetPreference(ctx, m.id, m.version);
          state = { ...state, modal: null };
          rebuild();
          state = setStatus(state, { text: "Forgot preference.", kind: "info" });
          break;
        }
        case "runTransition": {
          const m = state.modal;
          if (!m || m.type !== "actions") break;
          const label = transitionPreference(ctx, m.id, m.version, action.transition);
          state = { ...state, modal: null };
          rebuild();
          state = setStatus(state, {
            text: `${label} ${PAST[action.transition] ?? action.transition}.`,
            kind: "info",
          });
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Known, user-facing failures (empty repo, optimistic-concurrency conflict, bad
      // input) are shown in the footer and the UI stays alive. The view is rebuilt so
      // the display reflects whatever actually happened.
      try {
        rebuild();
      } catch {
        /* if the rebuild itself fails, keep the prior view */
      }
      state = setStatus(state, { text: msg, kind: "error" });
    }
  }

  function dispatch(action: Action): void {
    if (isEffect(action)) runEffect(action);
    else state = reduce(state, action);
    if (state.quit) {
      finalize();
      return;
    }
    render();
  }

  terminal.onKey((data) => {
    if (finalized) return;
    try {
      const key = decodeKey(data);
      if (!key) return;
      const action = keyToAction(state, key);
      if (action) dispatch(action);
    } catch (err) {
      finalize(err); // an unexpected error must still restore the terminal
    }
  });

  terminal.onResize(() => {
    if (finalized) return;
    try {
      state = resize(state, terminal.size());
      render();
    } catch (err) {
      finalize(err);
    }
  });

  if (managed) {
    for (const signal of ["SIGINT", "SIGTERM"] as NodeJS.Signals[]) {
      const handler = () => finalize();
      signalHandlers.push({ signal, handler });
      process.on(signal, handler);
    }
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUncaught);
  }

  render();
  await done;
}
