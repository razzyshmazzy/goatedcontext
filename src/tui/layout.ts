/**
 * Low-level layout + styling primitives. A `StyledLine` is a plain string already
 * truncated/padded to a known VISIBLE width, plus a single whole-line style. Styling a
 * whole line (never a substring) means we never have to reason about ANSI escape widths
 * when stitching columns — the plain text alignment is exact, and color is applied last.
 * When color is disabled (non-TTY, NO_COLOR) the ANSI is simply omitted.
 */

export interface Style {
  invert?: boolean;
  dim?: boolean;
  bold?: boolean;
  /** SGR foreground code (e.g. 36 = cyan). Omitted = default terminal color. */
  fg?: number;
}

export interface StyledLine {
  text: string;
  style: Style;
}

export const RESET = "\x1b[0m";

// Layout band sizes (rows). The body is everything between the header/rule and footer.
export const HEADER_LINES = 2;
export const RULE_LINES = 1;
export const FOOTER_LINES = 2;

export const MIN_COLS = 70;
export const MIN_ROWS = 20;

export function bodyHeight(rows: number): number {
  return Math.max(1, rows - HEADER_LINES - RULE_LINES - FOOTER_LINES);
}

/**
 * How many 2-line list items fit the pane. Shared by the renderer AND the state
 * windowing math so the selected row can never scroll off-screen. The pane spends one
 * line on the section title and one on spacing/the scroll hint, leaving the rest for
 * items.
 */
export function listCapacity(size: { cols: number; rows: number }): number {
  const area = Math.max(2, bodyHeight(size.rows) - 2);
  return Math.max(1, Math.floor(area / 2));
}

/** Visible width of a string (code points; the glyphs we use are all width-1). */
export function width(text: string): number {
  return Array.from(text).length;
}

/** Truncate to `w` visible columns, adding an ellipsis when it had to cut. */
export function truncate(text: string, w: number): string {
  if (w <= 0) return "";
  const chars = Array.from(text);
  if (chars.length <= w) return text;
  if (w === 1) return "…";
  return chars.slice(0, w - 1).join("") + "…";
}

/** Truncate then right-pad with spaces to exactly `w` visible columns. */
export function pad(text: string, w: number): string {
  const t = truncate(text, w);
  const gap = w - width(t);
  return gap > 0 ? t + " ".repeat(gap) : t;
}

export function sl(text: string, w: number, style: Style = {}): StyledLine {
  return { text: pad(text, w), style };
}

/** A line with `left` text and `right` text pinned to the right edge (1-col margin). */
export function twoCol(left: string, right: string, w: number): string {
  if (w <= 0) return "";
  const space = Math.max(0, w - width(right) - 1);
  return pad(left, space) + right + " ";
}

export function blank(w: number): StyledLine {
  return { text: " ".repeat(Math.max(0, w)), style: {} };
}

/** Pad/truncate an array of lines to exactly `height` entries of `w` columns. */
export function fit(lines: StyledLine[], w: number, height: number): StyledLine[] {
  const out: StyledLine[] = [];
  for (let i = 0; i < height; i++) {
    const line = lines[i];
    out.push(line ? { text: pad(line.text, w), style: line.style } : blank(w));
  }
  return out;
}

/** Render one styled line to a terminal string (or plain text when colors are off). */
export function toAnsi(line: StyledLine, colors: boolean): string {
  if (!colors) return line.text;
  const codes: number[] = [];
  if (line.style.bold) codes.push(1);
  if (line.style.dim) codes.push(2);
  if (line.style.invert) codes.push(7);
  if (line.style.fg != null) codes.push(line.style.fg);
  if (codes.length === 0) return line.text;
  return `\x1b[${codes.join(";")}m${line.text}${RESET}`;
}
