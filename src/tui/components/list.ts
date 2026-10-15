/**
 * The right-pane list for a memory section. Each item is two lines (title + compact
 * metadata). Only the visible window is rendered (spec §24 windowing), and the selected
 * item is highlighted. Empty and no-match states read intentionally (spec §17).
 */
import type { AppState } from "../state.ts";
import { activeSection, visibleRows } from "../state.ts";
import { listCapacity, type StyledLine, blank, sl, truncate, twoCol } from "../layout.ts";

const ACCENT = 36;

export function renderList(state: AppState, w: number, height: number): StyledLine[] {
  const section = activeSection(state);
  const lines: StyledLine[] = [];
  if (!section) return padTo(lines, w, height);

  const rows = visibleRows(state);
  const focusList = state.focus === "list" || state.search != null;
  const counter = rows.length > 0 ? `${state.listIndex + 1}/${rows.length}` : "0";
  lines.push({
    text: twoCol(` ${section.label}`, counter, w),
    style: { bold: true, fg: focusList ? ACCENT : undefined },
  });
  if (state.search != null) {
    lines.push(sl(` /${state.search}`, w, { dim: true, fg: ACCENT }));
  } else {
    lines.push(blank(w));
  }

  if (rows.length === 0) {
    const body = state.search != null ? ["No matches."] : section.emptyText;
    for (const l of body) lines.push(sl("   " + l, w, { dim: true }));
    return padTo(lines, w, height);
  }

  const cap = listCapacity(state.size);
  const end = Math.min(rows.length, state.listOffset + cap);
  for (let i = state.listOffset; i < end; i++) {
    const row = rows[i]!;
    const selected = i === state.listIndex;
    const title = ` ${selected ? ">" : " "} ${row.badge} ${row.title}`;
    const meta = `       ${row.meta}`;
    if (selected) {
      lines.push(sl(truncate(title, w), w, { invert: true }));
      lines.push(sl(truncate(meta, w), w, { invert: true }));
    } else {
      lines.push(sl(title, w, {}));
      lines.push(sl(meta, w, { dim: true }));
    }
  }
  if (end < rows.length || state.listOffset > 0) {
    lines.push(sl(`   … ${rows.length} total`, w, { dim: true }));
  }
  return padTo(lines, w, height);
}

function padTo(lines: StyledLine[], w: number, height: number): StyledLine[] {
  while (lines.length < height) lines.push(blank(w));
  return lines.slice(0, height);
}
