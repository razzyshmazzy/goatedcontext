/**
 * The frame composer. `renderLines(state)` returns the full screen as terminal strings —
 * pure, so tests can assert on fragments without a TTY. It picks a responsive layout
 * (wide 3-pane → full 2-pane → narrow tab-strip → tiny message, spec §15), draws titled
 * rounded panels whose borders light up when focused, and composites modals over a
 * dimmed backdrop.
 */
import type { AppState } from "./state.ts";
import { activeNav, activeSection, selectedRow } from "./state.ts";
import {
  MIN_COLS,
  MIN_ROWS,
  NARROW_COLS,
  RESET_ALL,
  bar,
  bodyHeight,
  panel,
  renderLine,
  span,
  type PanelLine,
  type Theme,
} from "./layout.ts";
import { dimmed } from "./theme.ts";
import { memoryRows, agentRows } from "./components/sidebar.ts";
import { listContent } from "./components/list.ts";
import {
  agentDetail,
  placeholderDetail,
  preferenceDetail,
  signalDetail,
} from "./components/detail.ts";
import { footerHints, statusLine } from "./components/statusbar.ts";
import { overlayModal } from "./components/modal.ts";

const WIDE_COLS = 108;

type Mode = "wide" | "full" | "narrow" | "tiny";

function layoutMode(size: { cols: number; rows: number }): Mode {
  if (size.cols < MIN_COLS || size.rows < MIN_ROWS) return "tiny";
  if (size.cols < NARROW_COLS) return "narrow";
  if (size.cols >= WIDE_COLS) return "wide";
  return "full";
}

function sidebarWidth(cols: number): number {
  return Math.max(22, Math.min(30, Math.floor(cols * 0.26)));
}

// ---- columns ----------------------------------------------------------------

function sidebarColumn(state: AppState, w: number, h: number, theme: Theme): string[] {
  const innerW = w - 2;
  const memH = Math.min(h - 3, 2 + state.vm.sections.length);
  const agentsH = h - memH;
  const focused = state.focus === "sidebar";
  const navIsSection = activeNav(state)?.kind === "section";
  const navIsAgent = activeNav(state)?.kind === "agent";
  const memory = panel({
    width: w,
    height: memH,
    title: "Memory",
    focused: focused && navIsSection,
    content: memoryRows(state, innerW),
    theme,
  });
  const agents = panel({
    width: w,
    height: agentsH,
    title: "Agents",
    focused: focused && navIsAgent,
    content: agentRows(state, innerW),
    theme,
  });
  return [...memory, ...agents];
}

function detailLinesFor(state: AppState, innerW: number): { title: string; lines: PanelLine[] } {
  const nav = activeNav(state);
  if (nav?.kind === "agent") {
    const agent = state.vm.agents.find((a) => a.id === nav.id);
    if (agent) return { title: agent.label, lines: agentDetail(agent, innerW) };
  }
  const section = activeSection(state);
  if (section && !section.enabled) return { title: "Vector Memory", lines: placeholderDetail(section, innerW) };
  const row = selectedRow(state);
  if (row?.data.kind === "preference") return { title: "Preference", lines: preferenceDetail(row.data, innerW) };
  if (row?.data.kind === "signal") return { title: "Signal", lines: signalDetail(row.data, innerW) };
  return { title: "Detail", lines: [{ spans: [span("")] }, { spans: [span("  Nothing selected.", { dim: true })] }] };
}

/** The single content panel used in full/narrow mode: list, detail, placeholder, agent. */
function contentColumn(state: AppState, w: number, h: number, theme: Theme): string[] {
  const innerW = w - 2;
  const nav = activeNav(state);
  const section = activeSection(state);
  const focused = state.focus === "list" || state.search != null;
  const searching = state.search != null;

  // Agent / vector / inspected-detail all show a detail card; otherwise the list.
  const showDetail =
    nav?.kind === "agent" || (section && !section.enabled) || state.detailOpen;

  if (showDetail) {
    const { title, lines } = detailLinesFor(state, innerW);
    return panel({ width: w, height: h, title, focused, content: lines, theme });
  }
  const count = section ? (searching ? undefined : section.rows.length) : undefined;
  return panel({
    width: w,
    height: h,
    title: section ? section.label : "Items",
    count,
    rightInfo: searching ? `/${state.search}` : undefined,
    focused,
    searching,
    content: listContent(state, innerW),
    theme,
  });
}

/** Wide-mode list column (always the list). */
function listColumn(state: AppState, w: number, h: number, theme: Theme): string[] {
  const section = activeSection(state)!;
  const focused = state.focus === "list" || state.search != null;
  const searching = state.search != null;
  return panel({
    width: w,
    height: h,
    title: section.label,
    count: searching ? undefined : section.rows.length,
    rightInfo: searching ? `/${state.search}` : undefined,
    focused,
    searching,
    content: listContent(state, w - 2),
    theme,
  });
}

function detailColumn(state: AppState, w: number, h: number, theme: Theme): string[] {
  const { title, lines } = detailLinesFor(state, w - 2);
  return panel({ width: w, height: h, title, focused: false, content: lines, theme });
}

// ---- bands ------------------------------------------------------------------

function headerBand(state: AppState, cols: number, theme: Theme, mode: Mode): string {
  const left =
    mode === "narrow"
      ? [span(" ctx", { fg: "accent", bold: true })]
      : [span(" goatedcontext", { fg: "accent", bold: true }), span("  ·  developer memory", { dim: true })];
  const right = [
    span("repo ", { dim: true }),
    span(state.vm.repoLabel, {}),
    span(`   v${state.vm.version} `, { dim: true }),
  ];
  return bar(left, right, cols, theme);
}

function tabStrip(state: AppState, cols: number, theme: Theme): string {
  const nav = activeNav(state);
  const activeKey = nav?.kind === "section" ? activeSection(state)?.key : null;
  const onAgents = nav?.kind === "agent";
  const tabs = state.vm.sections.map((s) => ({ label: s.label, active: s.key === activeKey }));
  const spans = [span(" ")];
  for (const t of tabs) {
    spans.push(
      t.active
        ? span(` ${t.label} `, { fg: "onAccent", bg: "accent", bold: true })
        : span(` ${t.label} `, { dim: true }),
    );
  }
  spans.push(onAgents ? span(" Agents ", { fg: "onAccent", bg: "accent", bold: true }) : span(" Agents ", { dim: true }));
  return renderLine(spans, cols, theme);
}

function footerBands(state: AppState, cols: number, theme: Theme): [string, string] {
  const { left, right } = footerHints(state);
  return [bar(left, right, cols, theme), renderLine(statusLine(state), cols, theme)];
}

function zip(columns: string[][], gap: number, height: number): string[] {
  const g = " ".repeat(gap);
  const out: string[] = [];
  for (let i = 0; i < height; i++) out.push(columns.map((c) => c[i] ?? "").join(g));
  return out;
}

function tinyScreen(cols: number, rows: number, theme: Theme): string[] {
  const msg = [
    span("Terminal too small", { bold: true }),
    span(`resize to at least ${MIN_COLS}×${MIN_ROWS}`, { dim: true }),
    span(`now ${cols}×${rows}`, { dim: true }),
  ];
  const out: string[] = [];
  const top = Math.max(0, Math.floor((rows - msg.length) / 2));
  for (let i = 0; i < rows; i++) {
    const m = msg[i - top];
    out.push(m ? renderLine([span(" ".repeat(Math.max(0, Math.floor((cols - m.text.length) / 2)))), m], cols, theme) : " ".repeat(cols));
  }
  return out;
}

// ---- frame ------------------------------------------------------------------

function buildFrame(state: AppState, theme: Theme): string[] {
  const { cols, rows } = state.size;
  const mode = layoutMode(state.size);
  if (mode === "tiny") return tinyScreen(cols, rows, theme);

  const h = bodyHeight(rows);
  const out: string[] = [];

  if (mode === "narrow") {
    out.push(headerBand(state, cols, theme, mode));
    out.push(tabStrip(state, cols, theme));
    const content = contentColumn(state, cols, h - 1, theme);
    for (const l of content) out.push(l);
  } else {
    out.push(headerBand(state, cols, theme, mode));
    const sw = sidebarWidth(cols);
    const nav = activeNav(state);
    const section = activeSection(state);
    const canThreePane =
      mode === "wide" &&
      nav?.kind === "section" &&
      section != null &&
      section.enabled &&
      !state.detailOpen &&
      section.rows.length > 0;

    if (canThreePane) {
      const detailW = Math.max(34, Math.floor(cols * 0.32));
      const listW = cols - sw - detailW - 2;
      const sidebar = sidebarColumn(state, sw, h, theme);
      const list = listColumn(state, listW, h, theme);
      const detail = detailColumn(state, detailW, h, theme);
      for (const l of zip([sidebar, list, detail], 1, h)) out.push(l);
    } else {
      const contentW = cols - sw - 1;
      const sidebar = sidebarColumn(state, sw, h, theme);
      const content = contentColumn(state, contentW, h, theme);
      for (const l of zip([sidebar, content], 1, h)) out.push(l);
    }
  }

  const [hints, status] = footerBands(state, cols, theme);
  out.push(hints);
  out.push(status);
  return out;
}

/** Full screen as an array of terminal line strings (no cursor control). */
export function renderLines(state: AppState): string[] {
  if (state.modal) {
    const backdrop = buildFrame(state, dimmed(state.theme));
    return overlayModal(backdrop, state);
  }
  return buildFrame(state, state.theme);
}

/** The full screen string: home the cursor, repaint every row, clear anything below. */
export function renderFrame(state: AppState): string {
  const lines = renderLines(state);
  return "\x1b[H" + lines.map((l) => l + "\x1b[K").join("\r\n") + RESET_ALL + "\x1b[J";
}
