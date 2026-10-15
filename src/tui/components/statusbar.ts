/**
 * The footer: a context-aware key-hint bar (hints left, context right — UX #11) over a
 * transient status line. Shortcut glyphs render in the accent color and labels dim, so
 * the keys pop without shouting (UX #12). Hints change with the active mode so the
 * controls are always discoverable (spec §14) without a manual.
 */
import type { AppState } from "../state.ts";
import { activeNav, activeSection } from "../state.ts";
import { type Line, type Span, span } from "../layout.ts";

type Hint = [key: string, label: string];

function hints(state: AppState): Hint[] {
  if (state.modal) {
    switch (state.modal.type) {
      case "help":
        return [["esc", "close"]];
      case "add":
        return [["tab", "field"], ["↵", "save"], ["esc", "cancel"]];
      case "actions":
        return [["↑↓", "choose"], ["↵", "apply"], ["esc", "cancel"]];
      case "confirm":
        return [["y", "yes"], ["n", "no"]];
    }
  }
  if (state.search != null) return [["type", "filter"], ["↵", "open"], ["esc", "clear"]];
  const nav = activeNav(state);
  if (nav?.kind === "agent") return [["↑↓", "move"], ["tab", "panel"], ["?", "help"], ["q", "quit"]];
  return [
    ["↑↓", "move"],
    ["↵", "inspect"],
    ["a", "add"],
    ["e", "edit"],
    ["d", "forget"],
    ["/", "search"],
    ["tab", "panel"],
    ["?", "help"],
    ["q", "quit"],
  ];
}

export function footerHints(state: AppState): { left: Line; right: Line } {
  const left: Span[] = [];
  for (const [key, label] of hints(state)) {
    left.push(span(" " + key + " ", { fg: "accent" }));
    left.push(span(label + "  ", { dim: true }));
  }

  const section = activeSection(state);
  const nav = activeNav(state);
  let mode: string;
  let count: string;
  if (nav?.kind === "agent") {
    mode = "agents";
    count = `${state.vm.agents.length} integrations`;
  } else if (section) {
    mode = section.label.toLowerCase();
    count = section.enabled ? `${section.rows.length} items` : "reserved";
  } else {
    mode = "";
    count = "";
  }

  const right: Span[] = [
    span(mode, { fg: "accent" }),
    span("  ·  ", { dim: true }),
    span(count + " ", { dim: true }),
  ];
  return { left, right };
}

export function statusLine(state: AppState): Line {
  if (!state.status) return [span("")];
  const s = state.status;
  const glyph = s.kind === "error" ? "✗ " : "✓ ";
  const style = s.kind === "error" ? { fg: "danger" as const, bold: true } : { fg: "success" as const };
  return [span(" " + glyph + s.text, style)];
}
