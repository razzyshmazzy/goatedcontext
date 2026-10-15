/**
 * The frame composer. `renderFrame(state)` returns the full terminal string for the
 * current state — pure (no I/O), so a test can assert on fragments without a TTY. It
 * dispatches the right pane (list / detail / agent / Vector placeholder / modal) and
 * stitches the two columns, header and footer into one screen.
 */
import type { AppState } from "./state.ts";
import { activeNav, activeSection, selectedRow } from "./state.ts";
import {
  MIN_COLS,
  MIN_ROWS,
  RESET,
  type StyledLine,
  bodyHeight,
  pad,
  toAnsi,
  twoCol,
} from "./layout.ts";
import { renderSidebar } from "./components/sidebar.ts";
import { renderList } from "./components/list.ts";
import {
  renderAgentDetail,
  renderPlaceholder,
  renderPreferenceDetail,
  renderSignalDetail,
} from "./components/detail.ts";
import { renderFooter } from "./components/statusbar.ts";
import { renderModal } from "./components/modal.ts";

const ACCENT = 36;

function sidebarWidth(cols: number): number {
  return Math.max(18, Math.min(28, Math.floor(cols * 0.3)));
}

function renderPane(state: AppState, w: number, height: number): StyledLine[] {
  const nav = activeNav(state);
  if (nav && nav.kind === "agent") {
    const agent = state.vm.agents.find((a) => a.id === nav.id);
    if (agent) return renderAgentDetail(agent, w, height);
  }
  const section = activeSection(state);
  if (!section) return renderList(state, w, height);
  if (!section.enabled) return renderPlaceholder(section, w, height);
  if (state.detailOpen) {
    const row = selectedRow(state);
    if (row && row.data.kind === "preference") return renderPreferenceDetail(row.data, w, height);
    if (row && row.data.kind === "signal") return renderSignalDetail(row.data, w, height);
  }
  return renderList(state, w, height);
}

function tooSmall(cols: number, rows: number): string[] {
  const msg = [
    "Terminal too small.",
    `Minimum recommended: ${MIN_COLS}x${MIN_ROWS}`,
    `Current: ${cols}x${rows}`,
  ];
  const out: string[] = [];
  const top = Math.max(0, Math.floor((rows - msg.length) / 2));
  for (let i = 0; i < rows; i++) {
    const m = msg[i - top];
    out.push(m ? pad(m, cols) : pad("", cols));
  }
  return out;
}

/** Build the array of terminal line strings (no cursor control), one per screen row. */
export function renderLines(state: AppState): string[] {
  const { cols, rows } = state.size;
  const colors = state.colors;
  if (cols < MIN_COLS || rows < MIN_ROWS) return tooSmall(cols, rows);

  if (state.modal) {
    const frame = renderModal(state);
    const out = frame.map((l) => toAnsi(l, colors));
    // Keep the key hints visible beneath the modal.
    const footer = renderFooter(state, cols);
    out[rows - 1] = toAnsi(footer[0]!, colors);
    return out;
  }

  const out: string[] = [];
  // Header.
  out.push(toAnsi({ text: twoCol(" goatedcontext", `v${state.vm.version} `, cols), style: { bold: true, fg: ACCENT } }, colors));
  out.push(toAnsi({ text: pad(` repo: ${state.vm.repoLabel}`, cols), style: { dim: true } }, colors));
  out.push(toAnsi({ text: "─".repeat(cols), style: { dim: true } }, colors));

  // Body (two columns).
  const height = bodyHeight(rows);
  const sw = sidebarWidth(cols);
  const pw = cols - sw - 1;
  const sidebar = renderSidebar(state, sw, height);
  const pane = renderPane(state, pw, height);
  const divider = toAnsi({ text: "│", style: { dim: true } }, colors);
  for (let i = 0; i < height; i++) {
    out.push(toAnsi(sidebar[i]!, colors) + divider + toAnsi(pane[i]!, colors));
  }

  // Footer.
  const footer = renderFooter(state, cols);
  out.push(toAnsi(footer[0]!, colors));
  out.push(toAnsi(footer[1]!, colors));
  return out;
}

/** The full screen string: home the cursor, repaint every row, clear anything below. */
export function renderFrame(state: AppState): string {
  const lines = renderLines(state);
  return "\x1b[H" + lines.map((l) => l + "\x1b[K").join("\r\n") + RESET + "\x1b[J";
}
