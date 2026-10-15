import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { makeTestContext } from "./helpers.ts";
import { shouldLaunchTui } from "../src/tui/launch.ts";
import { decodeKey, keyToAction } from "../src/tui/input.ts";
import {
  actionsFor,
  activeSection,
  initState,
  isEffect,
  reduce,
  selectedRow,
  visibleRows,
  type AppState,
} from "../src/tui/state.ts";
import {
  addPreference,
  buildViewModel,
  forgetPreference,
  transitionPreference,
} from "../src/tui/data.ts";
import { renderLines } from "../src/tui/renderer.ts";
import { runTui } from "../src/tui/app.ts";
import type { CtxContext } from "../src/core/context.ts";

const ROOT = join(import.meta.dir, "..");
const SIZE = { cols: 100, rows: 30 };

/** Deterministic view-model: bogus agent homes + empty PATH → every agent "not installed". */
function buildVM(ctx: CtxContext, dir: string) {
  return buildViewModel(ctx, {
    cwd: dir,
    env: { PATH: "" } as NodeJS.ProcessEnv,
    claudeHome: join(dir, "no-claude"),
    codexHome: join(dir, "no-codex"),
    cursorHome: join(dir, "no-cursor"),
  });
}

function stateWith(ctx: CtxContext, dir: string): AppState {
  return initState(buildVM(ctx, dir), { size: SIZE, colors: false });
}

function remember(ctx: CtxContext, rule: string, status: "approved" | "locked" = "approved") {
  return ctx.preferences.remember({ rule, scope: "global", origin: "user", source: "explicit", status });
}

// ---- routing (spec §2) ------------------------------------------------------

test("bare `ctx` on an interactive TTY launches the TUI", () => {
  expect(
    shouldLaunchTui({ args: [], hasPassthrough: false, stdinTTY: true, stdoutTTY: true, env: {} }),
  ).toBe(true);
});

test("`ctx --help` / any subcommand does NOT launch the TUI", () => {
  const base = { hasPassthrough: false, stdinTTY: true, stdoutTTY: true, env: {} };
  expect(shouldLaunchTui({ ...base, args: ["--help"] })).toBe(false);
  expect(shouldLaunchTui({ ...base, args: ["prefs"] })).toBe(false);
});

test("non-TTY, passthrough, and CTX_NO_TUI all fall through to the CLI", () => {
  expect(shouldLaunchTui({ args: [], hasPassthrough: false, stdinTTY: false, stdoutTTY: true, env: {} })).toBe(false);
  expect(shouldLaunchTui({ args: [], hasPassthrough: false, stdinTTY: true, stdoutTTY: false, env: {} })).toBe(false);
  expect(shouldLaunchTui({ args: [], hasPassthrough: true, stdinTTY: true, stdoutTTY: true, env: {} })).toBe(false);
  expect(
    shouldLaunchTui({ args: [], hasPassthrough: false, stdinTTY: true, stdoutTTY: true, env: { CTX_NO_TUI: "1" } }),
  ).toBe(false);
});

test("non-TTY `ctx` emits NO TUI escape codes", () => {
  const res = spawnSync(process.execPath, ["run", join(ROOT, "src", "index.ts")], {
    encoding: "utf8",
    input: "",
    env: { ...process.env },
  });
  const combined = (res.stdout ?? "") + (res.stderr ?? "");
  expect(combined).not.toContain("\x1b[?1049h"); // alternate screen
  expect(combined).not.toContain("\x1b[?25l"); // hide cursor
});

// ---- input decoding ---------------------------------------------------------

test("decodeKey maps the core keys", () => {
  expect(decodeKey("\x1b[A")?.name).toBe("up");
  expect(decodeKey("\x1b[B")?.name).toBe("down");
  expect(decodeKey("\x1bOC")?.name).toBe("right");
  expect(decodeKey("\r")?.name).toBe("enter");
  expect(decodeKey("\t")?.name).toBe("tab");
  expect(decodeKey("\x1b")?.name).toBe("escape");
  expect(decodeKey("\x7f")?.name).toBe("backspace");
  expect(decodeKey("\x03")?.name).toBe("ctrl-c");
  expect(decodeKey("a")).toEqual({ name: "char", ch: "a" });
});

// ---- navigation + focus (spec §8) -------------------------------------------

test("list navigation and tab/panel switching", () => {
  const { ctx, dir, cleanup } = makeTestContext();
  try {
    remember(ctx, "use bun");
    remember(ctx, "prefer postgres");
    let s = stateWith(ctx, dir);
    expect(s.navIndex).toBe(0); // Preferences
    expect(s.focus).toBe("sidebar");

    // tab into the list
    s = reduce(s, { type: "focusToggle" });
    expect(s.focus).toBe("list");
    expect(s.listIndex).toBe(0);

    // move down within the list
    s = reduce(s, { type: "navMove", delta: 1 });
    expect(s.listIndex).toBe(1);
    s = reduce(s, { type: "navMove", delta: 5 }); // clamps
    expect(s.listIndex).toBe(visibleRows(s).length - 1);

    // tab back to the sidebar, then move the sidebar selection
    s = reduce(s, { type: "focusToggle" });
    expect(s.focus).toBe("sidebar");
    s = reduce(s, { type: "navMove", delta: 1 });
    expect(activeSection(s)?.key).toBe("signals");
  } finally {
    cleanup();
  }
});

test("inspect opens the detail view for the selected row", () => {
  const { ctx, dir, cleanup } = makeTestContext();
  try {
    remember(ctx, "use bun");
    let s = stateWith(ctx, dir);
    s = reduce(s, { type: "inspect" });
    expect(s.focus).toBe("list");
    expect(s.detailOpen).toBe(true);
    expect(selectedRow(s)?.title).toBe("use bun");
  } finally {
    cleanup();
  }
});

// ---- add / edit / delete (spec §12) -----------------------------------------

test("add action calls the existing remember service", () => {
  const { ctx, dir, cleanup } = makeTestContext();
  try {
    const before = ctx.preferences.list().length;
    const pref = addPreference(ctx, { rule: "use tabs", scope: "global", cwd: dir });
    expect(pref.status).toBe("approved");
    const all = ctx.preferences.list();
    expect(all.length).toBe(before + 1);
    expect(all.some((p) => p.rule === "use tabs")).toBe(true);
  } finally {
    cleanup();
  }
});

test("delete requires confirmation: pressing `d` opens a confirm modal and deletes nothing", () => {
  const { ctx, dir, cleanup } = makeTestContext();
  try {
    const pref = remember(ctx, "use bun");
    let s = stateWith(ctx, dir);
    s = reduce(s, { type: "focusToggle" }); // focus the list
    const action = keyToAction(s, { name: "char", ch: "d" });
    expect(action).toEqual({ type: "openForget" });
    s = reduce(s, action!);
    expect(s.modal?.type).toBe("confirm");
    // Nothing deleted by opening the modal.
    expect(ctx.preferences.getById(pref.id)).not.toBeNull();

    // Confirming routes through the service (CAS).
    forgetPreference(ctx, pref.id, pref.version);
    expect(ctx.preferences.getById(pref.id)).toBeNull();
  } finally {
    cleanup();
  }
});

test("confirm modal: y confirms, n/esc cancel", () => {
  const { ctx, dir, cleanup } = makeTestContext();
  try {
    const pref = remember(ctx, "use bun");
    let s = stateWith(ctx, dir);
    s = reduce(s, { type: "focusToggle" });
    s = reduce(s, { type: "openForget" });
    expect(keyToAction(s, { name: "char", ch: "y" })).toEqual({ type: "confirmForget" });
    expect(keyToAction(s, { name: "char", ch: "n" })).toEqual({ type: "back" });
    expect(keyToAction(s, { name: "escape" })).toEqual({ type: "back" });
    void pref;
  } finally {
    cleanup();
  }
});

// ---- proposals + locked invariants (spec §11) -------------------------------

test("edit action approves/rejects via the existing transition services", () => {
  const { ctx, dir, cleanup } = makeTestContext();
  try {
    const { preference: p1 } = ctx.preferences.propose({
      rule: "use eslint",
      scope: "global",
      evidence: "observed",
      origin: "user",
    });
    transitionPreference(ctx, p1.id, p1.version, "approve");
    expect(ctx.preferences.getById(p1.id)?.status).toBe("approved");

    const { preference: p2 } = ctx.preferences.propose({
      rule: "use jest",
      scope: "global",
      evidence: "observed",
      origin: "user",
    });
    transitionPreference(ctx, p2.id, p2.version, "reject");
    expect(ctx.preferences.getById(p2.id)?.status).toBe("rejected");
    void dir;
  } finally {
    cleanup();
  }
});

test("locked preferences cannot be unlocked through the TUI actions menu", () => {
  const { ctx, dir, cleanup } = makeTestContext();
  try {
    const locked = remember(ctx, "always run the formatter", "locked");
    const s = stateWith(ctx, dir);
    void s;
    // The offered actions never include approve/unlock for a locked rule.
    const items = actionsFor({
      kind: "preference",
      id: locked.id,
      rule: locked.rule,
      scope: locked.scope,
      status: "locked",
      applicability: locked.applicability,
      domain: locked.domain,
      category: locked.category,
      polarity: locked.polarity,
      confidence: locked.confidence,
      version: locked.version,
      repoName: null,
      condition: null,
      createdAt: locked.createdAt,
      updatedAt: locked.updatedAt,
      lastUsedAt: locked.lastUsedAt,
      evidenceCount: 0,
      evidence: [],
    });
    expect(items.map((i) => i.transition)).not.toContain("approve");
    expect(items.map((i) => i.transition)).not.toContain("lock");

    // And even the underlying service refuses to silently downgrade a lock.
    transitionPreference(ctx, locked.id, locked.version, "approve");
    expect(ctx.preferences.getById(locked.id)?.status).toBe("locked");
  } finally {
    cleanup();
  }
});

// ---- search (spec §13) ------------------------------------------------------

test("search filters the active list live", () => {
  const { ctx, dir, cleanup } = makeTestContext();
  try {
    remember(ctx, "use bun");
    remember(ctx, "prefer postgres");
    let s = stateWith(ctx, dir);
    s = reduce(s, { type: "searchStart" });
    expect(s.search).toBe("");
    for (const ch of "bun") s = reduce(s, { type: "searchInput", ch });
    const rows = visibleRows(s);
    expect(rows.length).toBe(1);
    expect(rows[0]!.title).toBe("use bun");
    // esc clears the search.
    s = reduce(s, { type: "back" });
    expect(s.search).toBeNull();
    expect(visibleRows(s).length).toBe(2);
  } finally {
    cleanup();
  }
});

// ---- vector placeholder (spec §14) ------------------------------------------

test("Vector Memory renders an honest, not-enabled placeholder", () => {
  const { ctx, dir, cleanup } = makeTestContext();
  try {
    const vm = buildVM(ctx, dir);
    const vector = vm.sections.find((sec) => sec.key === "vector")!;
    expect(vector.enabled).toBe(false);
    expect(vector.rows.length).toBe(0);

    let s = initState(vm, { size: SIZE, colors: false });
    // Navigate to the Vector Memory section (4th nav entry).
    s = reduce(s, { type: "navMove", delta: 3 });
    expect(activeSection(s)?.key).toBe("vector");
    const screen = renderLines(s).join("\n");
    expect(screen).toContain("Not enabled yet");
    expect(screen).toContain("authoritative store");
    expect(screen.toLowerCase()).not.toContain("vector search is active");
  } finally {
    cleanup();
  }
});

// ---- agents (spec §16) ------------------------------------------------------

test("agents view is built from real status data", () => {
  const { ctx, dir, cleanup } = makeTestContext();
  try {
    const vm = buildVM(ctx, dir);
    expect(vm.agents.map((a) => a.label)).toEqual(["Claude Code", "Codex", "Cursor"]);
    for (const a of vm.agents) {
      expect(a.statusLabel.length).toBeGreaterThan(0);
      expect(["✓", "!", "·", "×"]).toContain(a.mark);
    }
    // Claude's config home is bogus here, so it is reported as not installed.
    const claude = vm.agents.find((a) => a.id === "claude")!;
    expect(claude.installed).toBe(false);
    expect(claude.mark).toBe("×");
  } finally {
    cleanup();
  }
});

// ---- effect classification --------------------------------------------------

test("mutations are classified as effects; UI actions are not", () => {
  expect(isEffect({ type: "submitAdd" })).toBe(true);
  expect(isEffect({ type: "confirmForget" })).toBe(true);
  expect(isEffect({ type: "runTransition", transition: "approve" })).toBe(true);
  expect(isEffect({ type: "refresh" })).toBe(true);
  expect(isEffect({ type: "navMove", delta: 1 })).toBe(false);
  expect(isEffect({ type: "inspect" })).toBe(false);
});

// ---- terminal lifecycle (spec §18) ------------------------------------------

interface FakeTerm {
  io: { stdin: unknown; stdout: unknown };
  out: () => string;
  raw: () => boolean | null;
  key: (data: string) => void;
}

function fakeTerminal(opts: { throwOnWriteCall?: number } = {}): FakeTerm {
  const chunks: string[] = [];
  let rawMode: boolean | null = null;
  let writeCalls = 0;
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode(m: boolean) {
      rawMode = m;
    },
    resume() {},
    pause() {},
    setEncoding() {},
  });
  const stdout = {
    columns: 100,
    rows: 30,
    write(data: string) {
      writeCalls++;
      if (opts.throwOnWriteCall && writeCalls >= opts.throwOnWriteCall) {
        throw new Error("simulated terminal write failure");
      }
      chunks.push(data);
      return true;
    },
    on() {},
    off() {},
  };
  return {
    io: { stdin, stdout },
    out: () => chunks.join(""),
    raw: () => rawMode,
    key: (data: string) => stdin.emit("data", data),
  };
}

test("quitting restores the terminal (raw mode off, alternate screen left)", async () => {
  const { ctx, dir, cleanup } = makeTestContext();
  const fake = fakeTerminal();
  try {
    const run = runTui(process.env, { ctx, io: fake.io as never, cwd: dir, colors: false });
    expect(fake.raw()).toBe(true); // raw mode engaged at startup
    fake.key("q");
    await run;
    expect(fake.raw()).toBe(false);
    expect(fake.out()).toContain("\x1b[?1049h"); // entered the alternate screen
    expect(fake.out()).toContain("\x1b[?1049l"); // and left it
    expect(fake.out()).toContain("\x1b[?25h"); // cursor restored
  } finally {
    cleanup();
  }
});

test("an exception during render still restores the terminal", async () => {
  const { ctx, dir, cleanup } = makeTestContext();
  remember(ctx, "use bun");
  // ENTER write = call 1, initial render = call 2; fail on the next render.
  const fake = fakeTerminal({ throwOnWriteCall: 3 });
  try {
    const run = runTui(process.env, { ctx, io: fake.io as never, cwd: dir, colors: false });
    expect(fake.raw()).toBe(true);
    fake.key("j"); // triggers a re-render that throws
    await run;
    expect(fake.raw()).toBe(false); // terminal restored despite the exception
  } finally {
    cleanup();
  }
});
