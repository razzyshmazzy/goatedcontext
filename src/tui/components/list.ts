/**
 * The content list for a section: each item is two lines (title + dim metadata). Only
 * the visible window is built (spec §24). The selected row gets a full-width accent bar
 * when the list is focused; search matches are highlighted in-place (spec §13). Empty
 * and no-match states render intentional copy with an action hint (spec §17).
 */
import type { AppState } from "../state.ts";
import { activeSection, visibleRows } from "../state.ts";
import type { ListRow } from "../types.ts";
import { listCapacity, type PanelLine, type Role, type Span, span, truncate } from "../layout.ts";

function badgeRole(row: ListRow): Role | "muted" {
  if (row.data.kind === "signal") return row.data.isException ? "warning" : "muted";
  switch (row.data.status) {
    case "locked":
      return "warning";
    case "approved":
      return "success";
    default:
      return "accent";
  }
}

/** Split a title around the first case-insensitive match of `query` for highlighting. */
function titleSpans(title: string, query: string | null, selected: boolean): Span[] {
  const base: Role = selected ? "onAccent" : "text";
  const baseStyle = selected ? { fg: base, bold: true } : {};
  if (!query) return [span(title, baseStyle)];
  const i = title.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return [span(title, baseStyle)];
  const hl = selected ? { fg: "onAccent" as Role, bold: true } : { fg: "accent" as Role, bold: true };
  return [
    span(title.slice(0, i), baseStyle),
    span(title.slice(i, i + query.length), hl),
    span(title.slice(i + query.length), baseStyle),
  ];
}

function emptyLines(lines: string[]): PanelLine[] {
  return [
    { spans: [span("")] },
    ...lines.map((l, i) => ({
      spans: [span("   " + l, i === 0 ? { dim: false } : { dim: true })],
    })),
  ];
}

export function listContent(state: AppState, innerW: number): PanelLine[] {
  const section = activeSection(state);
  if (!section) return [];
  const rows = visibleRows(state);

  if (rows.length === 0) {
    if (state.search != null) {
      return emptyLines([`No matches for "${state.search}".`, "", "Esc clears the filter."]);
    }
    return emptyLines(section.emptyText);
  }

  const cap = listCapacity(state.size);
  const focused = state.focus === "list" || state.search != null;
  const end = Math.min(rows.length, state.listOffset + cap);
  const out: PanelLine[] = [];

  for (let i = state.listOffset; i < end; i++) {
    const r = rows[i]!;
    const selected = i === state.listIndex;
    const bar = selected && focused;
    const markerStyle = bar ? { fg: "onAccent" as Role } : { fg: badgeRole(r) as Role };
    const marker = selected ? "›" : " ";
    const titleW = Math.max(1, innerW - 5);
    const title = truncate(r.title, titleW);
    const titleLine: Span[] = [
      span(` ${marker} `, bar ? { fg: "onAccent" } : {}),
      span(r.badge + " ", markerStyle),
      ...titleSpans(title, state.search && state.search.length ? state.search : null, bar),
    ];
    const metaStyle = bar ? { fg: "onAccent" as Role } : { dim: true };
    const metaLine: Span[] = [span("     " + truncate(r.meta, Math.max(1, innerW - 6)), metaStyle)];
    out.push({ spans: titleLine, bg: bar ? "accent" : undefined });
    out.push({ spans: metaLine, bg: bar ? "accent" : undefined });
  }

  if (rows.length > cap) {
    const shown = `${state.listIndex + 1} of ${rows.length}`;
    out.push({ spans: [span(`   ${shown}`, { dim: true })] });
  }
  return out;
}
