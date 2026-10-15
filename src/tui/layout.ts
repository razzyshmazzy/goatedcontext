/**
 * Layout primitives. A `Line` is an ordered list of styled `Span`s; the renderer turns
 * it into an exact, width-correct terminal string. Width is measured with `string-width`
 * so wide/CJK/emoji glyphs in user content never knock the columns out of alignment.
 *
 * Higher-level helpers here draw the modern chrome: titled rounded `panel`s whose border
 * turns accent when focused (spec §4 patterns), and space-between `bar`s for the header
 * and footer (hints left, context right).
 */
import stringWidth from "string-width";
import type { Role, Style, Theme } from "./theme.ts";

export type { Role, Style, Theme } from "./theme.ts";

export const RESET_ALL = "\x1b[0m";

export interface Span {
  text: string;
  style?: Style;
}

export type Line = Span[];

/** A content line for a panel, optionally with a full-row background (selection bar). */
export interface PanelLine {
  spans: Span[];
  bg?: Role;
}

// Rounded box-drawing set (spec §3 modern aesthetic); all glyphs are width-1.
export const BOX = {
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  h: "─",
  v: "│",
} as const;

export const MIN_COLS = 56;
export const MIN_ROWS = 16;
/** Below this width the detail collapses and the sidebar becomes a tab strip. */
export const NARROW_COLS = 84;

export function width(text: string): number {
  return stringWidth(text);
}

/** Truncate to `w` visible columns, width-aware, adding an ellipsis when it had to cut. */
export function truncate(text: string, w: number): string {
  if (w <= 0) return "";
  if (width(text) <= w) return text;
  if (w === 1) return "…";
  let out = "";
  let used = 0;
  for (const ch of text) {
    const cw = width(ch);
    if (used + cw > w - 1) break;
    out += ch;
    used += cw;
  }
  return out + "…";
}

export function pad(text: string, w: number): string {
  const t = truncate(text, w);
  const gap = w - width(t);
  return gap > 0 ? t + " ".repeat(gap) : t;
}

export function span(text: string, style?: Style): Span {
  return style ? { text, style } : { text };
}

/** Render a line of spans to exactly `w` columns; `bg` fills the whole row (selection). */
export function renderLine(spans: Line, w: number, theme: Theme, bg?: Role): string {
  let used = 0;
  const parts: string[] = [];
  for (const s of spans) {
    if (used >= w) break;
    let t = s.text;
    let tw = width(t);
    if (used + tw > w) {
      t = truncate(t, w - used);
      tw = width(t);
    }
    if (t.length === 0) continue;
    const style: Style = bg ? { ...s.style, bg: s.style?.bg ?? bg } : { ...s.style };
    parts.push(theme.wrap(t, style));
    used += tw;
  }
  if (used < w) {
    const padText = " ".repeat(w - used);
    parts.push(bg ? theme.wrap(padText, { bg }) : padText);
  }
  return parts.join("");
}

/** A full-width bar with `left` spans pinned left and `right` spans pinned right. */
export function bar(left: Line, right: Line, w: number, theme: Theme): string {
  const leftW = left.reduce((n, s) => n + width(s.text), 0);
  const rightW = right.reduce((n, s) => n + width(s.text), 0);
  if (leftW + rightW + 1 > w) {
    // Not enough room for both: keep the left side, truncate it to fit.
    return renderLine(left, w, theme);
  }
  const gap = span(" ".repeat(w - leftW - rightW));
  return renderLine([...left, gap, ...right], w, theme);
}

export interface PanelOptions {
  width: number;
  height: number;
  title: string;
  /** Optional count shown dim after the title, e.g. "Preferences 14". */
  count?: number | string;
  /** Optional right-aligned info in the top border (e.g. a filter hint). */
  rightInfo?: string;
  focused: boolean;
  /** Tints the border amber to signal an active filter (spec §13 search mode). */
  searching?: boolean;
  /** Border/title role when focused (default "accent"; modals pass "danger" etc). */
  accent?: Role;
  content: PanelLine[];
  theme: Theme;
}

/**
 * Draw a titled, rounded panel. The border is accent when focused, amber while
 * filtering, and dim otherwise — the single clearest "which pane is live" cue
 * (spec §4). Content lines are rendered to the inner width; a row's `bg` paints a
 * full-width selection bar.
 */
export function panel(opts: PanelOptions): string[] {
  const { width: w, height, theme, focused, searching } = opts;
  const accentRole: Role = opts.accent ?? "accent";
  const innerW = Math.max(0, w - 2);
  const borderStyle: Style = searching
    ? { fg: "warning" }
    : focused
      ? { fg: accentRole }
      : { dim: true };
  const titleStyle: Style = focused ? { fg: accentRole, bold: true } : { bold: true };

  // Top border: ╭─ Title (n) ─────── rightInfo ─╮
  const titlePlain = ` ${opts.title} `;
  const countPlain = opts.count != null ? `${opts.count} ` : "";
  const rightPlain = opts.rightInfo ? `${opts.rightInfo} ` : "";
  const fixed = 1 /*tl*/ + 1 /*h*/ + width(titlePlain) + width(countPlain) + width(rightPlain) + 1 /*tr*/;
  const fillW = Math.max(0, innerW + 2 - fixed - (rightPlain ? 1 : 0));
  const topSpans: Line = [
    span(BOX.tl + BOX.h, borderStyle),
    span(titlePlain, titleStyle),
  ];
  if (countPlain) topSpans.push(span(countPlain, { dim: true }));
  topSpans.push(span(BOX.h.repeat(fillW), borderStyle));
  if (rightPlain) topSpans.push(span(rightPlain, searching ? { fg: "warning" } : { dim: true }), span(BOX.h, borderStyle));
  topSpans.push(span(BOX.tr, borderStyle));

  const lines: string[] = [renderLine(topSpans, w, theme)];

  const bodyRows = Math.max(0, height - 2);
  for (let i = 0; i < bodyRows; i++) {
    const row = opts.content[i];
    const v = theme.wrap(BOX.v, borderStyle);
    if (!row) {
      lines.push(v + " ".repeat(innerW) + v);
      continue;
    }
    const inner = renderLine(row.spans, innerW, theme, row.bg);
    lines.push(v + inner + v);
  }
  lines.push(renderLine([span(BOX.bl + BOX.h.repeat(Math.max(0, innerW)) + BOX.br, borderStyle)], w, theme));
  return lines;
}

// Layout maths. The body sits between a 1-line header and a 2-line footer (a key-hint
// bar + a status line); each panel spends 2 rows on its top/bottom borders and 1 inner
// row on top padding.
export function bodyHeight(rows: number): number {
  return Math.max(3, rows - 3);
}

export function contentInnerHeight(rows: number): number {
  return Math.max(1, bodyHeight(rows) - 2 - 1);
}

/** How many 2-line list items fit the content panel (shared with state windowing). */
export function listCapacity(size: { cols: number; rows: number }): number {
  return Math.max(1, Math.floor(contentInnerHeight(size.rows) / 2));
}
