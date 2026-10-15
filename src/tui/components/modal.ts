/**
 * Full-screen modal overlays: Add preference, Actions (safe lifecycle transitions),
 * Forget confirmation, and Help. Rendering a modal as its own clean screen (rather than
 * compositing over the dashboard) keeps the draw logic simple and flicker-free. Each
 * returns a full `rows`-high frame so the renderer can emit it directly.
 */
import type { AppState, Modal } from "../state.ts";
import { type Style, type StyledLine, blank, sl, truncate } from "../layout.ts";

const ACCENT = 36;

interface Inner {
  text: string;
  style?: Style;
}

function box(cols: number, rows: number, title: string, inner: Inner[]): StyledLine[] {
  const boxW = Math.min(cols - 4, 66);
  const innerW = boxW - 4;
  const top = "┌" + "─".repeat(boxW - 2) + "┐";
  const bottom = "└" + "─".repeat(boxW - 2) + "┘";
  const border = (content: string): string => "│ " + content.padEnd(innerW).slice(0, innerW) + " │";

  const boxLines: StyledLine[] = [];
  const left = Math.max(0, Math.floor((cols - boxW) / 2));
  const indent = " ".repeat(left);
  const push = (s: string, style: Style = {}) => boxLines.push(sl(indent + s, cols, style));

  push(top, { fg: ACCENT });
  push(border(truncate(title, innerW)), { bold: true, fg: ACCENT });
  push(border(""));
  for (const line of inner) push(border(truncate(line.text, innerW)), line.style ?? {});
  push(border(""));
  push(bottom, { fg: ACCENT });

  // Center vertically.
  const frame: StyledLine[] = [];
  const top0 = Math.max(0, Math.floor((rows - boxLines.length) / 2));
  for (let i = 0; i < top0; i++) frame.push(blank(cols));
  for (const l of boxLines) frame.push(l);
  while (frame.length < rows) frame.push(blank(cols));
  return frame.slice(0, rows);
}

function innerFor(modal: Modal): { title: string; inner: Inner[] } {
  switch (modal.type) {
    case "help":
      return {
        title: "Keyboard",
        inner: [
          { text: "up/down, j/k   move selection" },
          { text: "tab            switch sidebar / list" },
          { text: "enter          inspect selected item" },
          { text: "left / h       back" },
          { text: "a              add a preference" },
          { text: "e              edit (approve / reject / lock)" },
          { text: "d              forget a preference" },
          { text: "/              search the list" },
          { text: "g / G          top / bottom" },
          { text: "r              refresh" },
          { text: "q              quit" },
        ],
      };
    case "confirm":
      return {
        title: "Confirm",
        inner: [
          ...modal.prompt.split("\n").map((t) => ({ text: t })),
          { text: "" },
          { text: "[y] yes    [n] no", style: { bold: true } },
        ],
      };
    case "actions":
      return {
        title: "Actions",
        inner: modal.items.map((it, i) => ({
          text: `${i === modal.index ? ">" : " "} ${it.label}`,
          style: i === modal.index ? ({ invert: true } as Style) : {},
        })),
      };
    case "add": {
      const scope =
        modal.scope === "global" ? "[ global ]  repo   " : " global   [ repo ]  ";
      return {
        title: "Add preference",
        inner: [
          { text: `${modal.field === 0 ? ">" : " "} Rule:  ${modal.rule}${modal.field === 0 ? "_" : ""}`,
            style: modal.field === 0 ? ({ fg: ACCENT } as Style) : {} },
          { text: "" },
          { text: `${modal.field === 1 ? ">" : " "} Scope: ${scope}`,
            style: modal.field === 1 ? ({ fg: ACCENT } as Style) : {} },
          { text: "" },
          { text: "Added as an approved preference (origin: you).", style: { dim: true } },
        ],
      };
    }
  }
}

export function renderModal(state: AppState): StyledLine[] {
  const modal = state.modal!;
  const { title, inner } = innerFor(modal);
  return box(state.size.cols, state.size.rows, title, inner);
}
