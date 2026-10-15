/**
 * Modal overlays composited over a DIMMED copy of the dashboard (UX #21): Add, Actions
 * (safe lifecycle transitions), a risk-scaled Forget confirmation, and a context-aware
 * Help sheet. The confirm dialog is tinted danger, names the destructive action, warns
 * it cannot be undone, and defaults to the safe choice (spec §16 / UX #15-16).
 */
import type { AppState, Modal } from "../state.ts";
import { type PanelLine, type Role, panel, span, width } from "../layout.ts";

function content(modal: Modal): { title: string; accent: Role; lines: PanelLine[] } {
  switch (modal.type) {
    case "help":
      return { title: "Keyboard", accent: "accent", lines: helpLines() };
    case "confirm":
      return { title: "Forget preference", accent: "danger", lines: confirmLines(modal) };
    case "actions":
      return { title: "Actions", accent: "accent", lines: actionLines(modal) };
    case "add":
      return { title: "Add preference", accent: "accent", lines: addLines(modal) };
  }
}

function key(k: string, label: string): PanelLine {
  return { spans: [span("  " + k.padEnd(8), { fg: "accent" }), span(label, { dim: true })] };
}

function helpLines(): PanelLine[] {
  return [
    { spans: [span("")] },
    key("↑↓ j k", "move selection"),
    key("tab", "switch sidebar / list"),
    key("enter", "inspect selected item"),
    key("a", "add a preference"),
    key("e", "edit (approve / reject / lock)"),
    key("d", "forget a preference"),
    key("/", "search the list"),
    key("g G", "jump to top / bottom"),
    key("r", "refresh"),
    key("?", "this help"),
    key("q", "quit"),
    { spans: [span("")] },
  ];
}

function confirmLines(modal: Extract<Modal, { type: "confirm" }>): PanelLine[] {
  const parts = modal.prompt.split("\n");
  const subject = parts[1] ?? "";
  return [
    { spans: [span("")] },
    { spans: [span("  Forget this preference? This cannot be undone.", { bold: true })] },
    { spans: [span("")] },
    { spans: [span("  “" + subject + "”", { fg: "warning" })] },
    { spans: [span("")] },
    {
      spans: [
        span("  y ", { fg: "danger", bold: true }),
        span("forget      ", { dim: true }),
        span("n ", { bold: true }),
        span("keep", { dim: true }),
      ],
    },
    { spans: [span("")] },
  ];
}

function actionLines(modal: Extract<Modal, { type: "actions" }>): PanelLine[] {
  const lines: PanelLine[] = [{ spans: [span("")] }];
  modal.items.forEach((it, i) => {
    const selected = i === modal.index;
    const role: Role = it.transition === "reject" ? "danger" : "accent";
    lines.push({
      spans: [
        span(selected ? "  › " : "    ", selected ? { fg: "onAccent" } : {}),
        span(it.label, selected ? { fg: "onAccent", bold: true } : { fg: role }),
      ],
      bg: selected ? "accent" : undefined,
    });
  });
  lines.push({ spans: [span("")] });
  return lines;
}

function addLines(modal: Extract<Modal, { type: "add" }>): PanelLine[] {
  const ruleFocused = modal.field === 0;
  const scopeFocused = modal.field === 1;
  const cursor = ruleFocused ? "▏" : "";
  const scope = (name: "global" | "repo") => {
    const on = modal.scope === name;
    return span(on ? ` ${name} ` : ` ${name} `, on ? { fg: "onAccent", bold: true, bg: "accent" } : { dim: true });
  };
  return [
    { spans: [span("")] },
    { spans: [span(ruleFocused ? "  › " : "    ", { fg: "accent" }), span("Rule", { dim: true })] },
    { spans: [span("    "), span(modal.rule + cursor, ruleFocused ? {} : { dim: true })] },
    { spans: [span("")] },
    {
      spans: [
        span(scopeFocused ? "  › " : "    ", { fg: "accent" }),
        span("Scope   ", { dim: true }),
        scope("global"),
        span(" "),
        scope("repo"),
      ],
    },
    { spans: [span("")] },
    { spans: [span("  Saved as an approved preference, origin: you.", { dim: true })] },
    { spans: [span("")] },
  ];
}

/** Composite the active modal, centered, over the (already dim) base frame lines. */
export function overlayModal(base: string[], state: AppState): string[] {
  const { cols, rows } = state.size;
  const { title, accent, lines } = content(state.modal!);

  const maxLineW = lines.reduce((m, l) => Math.max(m, l.spans.reduce((n, s) => n + width(s.text), 0)), 0);
  const boxW = Math.min(cols - 4, Math.max(width(title) + 8, maxLineW + 4, 44));
  const boxH = Math.min(rows - 2, lines.length + 2);
  const left = Math.max(0, Math.floor((cols - boxW) / 2));
  const top = Math.max(0, Math.floor((rows - boxH) / 2));

  const boxLines = panel({
    width: boxW,
    height: boxH,
    title,
    accent,
    focused: true,
    content: lines,
    theme: state.theme,
  });

  const out = base.slice();
  const leftPad = " ".repeat(left);
  const rightPad = " ".repeat(Math.max(0, cols - left - boxW));
  for (let j = 0; j < boxLines.length; j++) {
    const r = top + j;
    if (r >= 0 && r < out.length) out[r] = leftPad + boxLines[j] + rightPad;
  }
  return out;
}
