/**
 * The semantic color system. The UI authors in ROLES (accent / success / warning /
 * danger / muted / …), never raw ANSI codes, and the theme resolves each role to the
 * best encoding the terminal supports — truecolor → 256 → 16 → none — degrading
 * gracefully (spec §6). Chrome (borders, secondary text) leans on the portable `dim`
 * attribute rather than a fixed gray, so it reads on both dark and light themes; color
 * is reserved for meaning. State is NEVER communicated by color alone — every colored
 * marker is paired with a glyph or label (spec §16).
 */

export type ColorDepth = 0 | 1 | 2 | 3; // none | 16 | 256 | truecolor

export type Role =
  | "text"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "muted"
  | "subtle"
  | "onAccent";

export interface Style {
  fg?: Role;
  bg?: Role;
  bold?: boolean;
  dim?: boolean;
  reverse?: boolean;
}

interface ColorSpec {
  rgb: [number, number, number];
  x256: number;
  /** 16-color foreground SGR (30–37 / 90–97); background is derived as +10. */
  x16: number;
}

// A restrained, modern palette (Catppuccin-leaning). Only a handful of roles carry
// color; everything else is dim chrome. `text` has no color (the terminal default).
const PALETTE: Record<Role, ColorSpec | null> = {
  text: null,
  accent: { rgb: [137, 180, 250], x256: 111, x16: 94 }, // soft blue
  success: { rgb: [166, 227, 161], x256: 114, x16: 92 }, // green
  warning: { rgb: [249, 226, 175], x256: 223, x16: 93 }, // amber
  danger: { rgb: [243, 139, 168], x256: 211, x16: 91 }, // red
  muted: { rgb: [147, 153, 178], x256: 103, x16: 90 }, // gray
  subtle: { rgb: [88, 91, 112], x256: 240, x16: 90 }, // dim gray
  onAccent: { rgb: [17, 17, 27], x256: 235, x16: 30 }, // near-black on the accent bar
};

function fgCode(spec: ColorSpec, depth: ColorDepth): string {
  if (depth >= 3) return `38;2;${spec.rgb[0]};${spec.rgb[1]};${spec.rgb[2]}`;
  if (depth === 2) return `38;5;${spec.x256}`;
  return String(spec.x16);
}

function bgCode(spec: ColorSpec, depth: ColorDepth): string {
  if (depth >= 3) return `48;2;${spec.rgb[0]};${spec.rgb[1]};${spec.rgb[2]}`;
  if (depth === 2) return `48;5;${spec.x256}`;
  return String(spec.x16 + 10);
}

export interface Theme {
  depth: ColorDepth;
  /** Wrap text in SGR codes for `style`; returns the text unchanged when color is off. */
  wrap(text: string, style?: Style): string;
}

export function makeTheme(depth: ColorDepth): Theme {
  return {
    depth,
    wrap(text: string, style: Style = {}): string {
      if (depth === 0) return text;
      const codes: string[] = [];
      if (style.bold) codes.push("1");
      if (style.dim) codes.push("2");
      if (style.reverse) codes.push("7");
      const fg = style.fg ? PALETTE[style.fg] : null;
      const bg = style.bg ? PALETTE[style.bg] : null;
      if (fg) codes.push(fgCode(fg, depth));
      if (bg) codes.push(bgCode(bg, depth));
      if (codes.length === 0) return text;
      return `\x1b[${codes.join(";")}m${text}\x1b[0m`;
    },
  };
}

/** Detect the usable color depth from the environment + whether stdout is a TTY. */
export function detectDepth(env: NodeJS.ProcessEnv, isTTY: boolean): ColorDepth {
  if (!isTTY) return 0;
  if (env.NO_COLOR && env.NO_COLOR.length > 0) return 0;
  if (env.TERM === "dumb") return 0;
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm.includes("truecolor") || colorterm.includes("24bit")) return 3;
  // Windows Terminal and modern VS Code terminals support truecolor.
  if (env.WT_SESSION || env.TERM_PROGRAM === "vscode") return 3;
  const term = (env.TERM ?? "").toLowerCase();
  if (term.includes("256")) return 2;
  // Windows legacy conhost (no TERM) still does 256 since Windows 10.
  if (!term && process.platform === "win32") return 2;
  if (term) return 1;
  return 2;
}

export const NO_COLOR_THEME: Theme = makeTheme(0);

/**
 * A backdrop variant that forces everything dim and drops color — used to render the
 * dashboard behind an open modal so the overlay reads as a focus spotlight (UX #21).
 */
export function dimmed(theme: Theme): Theme {
  return {
    depth: theme.depth,
    wrap(text: string): string {
      if (theme.depth === 0) return text;
      return `\x1b[2m${text}\x1b[0m`;
    },
  };
}
