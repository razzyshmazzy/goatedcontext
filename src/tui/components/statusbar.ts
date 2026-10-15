/**
 * The two-line footer: a context-sensitive key-hint line and a transient status line.
 * Hints change with the active mode so the controls are always discoverable without a
 * manual (spec §4 footer help / §8 input model).
 */
import type { AppState } from "../state.ts";
import { type StyledLine, sl } from "../layout.ts";

function hints(state: AppState): string {
  if (state.modal) {
    switch (state.modal.type) {
      case "help":
        return "esc close";
      case "add":
        return "type rule   tab field   left/right scope   enter save   esc cancel";
      case "actions":
        return "up/down choose   enter apply   esc cancel";
      case "confirm":
        return "y yes   n no";
    }
  }
  if (state.search != null) return "type to filter   enter inspect   esc clear";
  return "up/down move   enter inspect   a add   e edit   d forget   / search   tab switch   ? help   q quit";
}

export function renderFooter(state: AppState, w: number): StyledLine[] {
  const keys = sl(" " + hints(state), w, { dim: true });
  const status = state.status;
  const statusLine = status
    ? sl(" " + status.text, w, status.kind === "error" ? { fg: 31, bold: true } : { fg: 36 })
    : sl("", w, {});
  return [keys, statusLine];
}
