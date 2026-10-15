/**
 * The left navigation column: a "Memory" group (the four sections with counts) and an
 * "Agents" group (detected integrations with a status glyph). The selected nav row is
 * highlighted; when focus is on the list the sidebar selection is shown bold rather than
 * inverted, so it's always clear which pane owns the cursor.
 */
import type { AppState, NavItem } from "../state.ts";
import { sectionByKey } from "../state.ts";
import { type Style, type StyledLine, blank, sl, truncate, twoCol } from "../layout.ts";

const ACCENT = 36; // cyan

function sectionLabel(state: AppState, key: string): { label: string; count: string } {
  const section = sectionByKey(state, key as never);
  if (!section) return { label: key, count: "" };
  const count = section.enabled ? String(section.rows.length) : "—";
  return { label: section.label, count };
}

function selectionStyle(selected: boolean, focusHere: boolean): Style {
  if (!selected) return {};
  if (focusHere) return { invert: true };
  return { bold: true, fg: ACCENT };
}

export function renderSidebar(state: AppState, w: number, height: number): StyledLine[] {
  const focusSidebar = state.focus === "sidebar" && !state.detailOpen && state.search == null;
  const lines: StyledLine[] = [];

  lines.push(sl(" Memory", w, { dim: true }));
  state.nav.forEach((item: NavItem, idx) => {
    if (item.kind !== "section") return;
    const selected = idx === state.navIndex;
    const { label, count } = sectionLabel(state, item.key);
    const marker = selected ? ">" : " ";
    const text = twoCol(` ${marker} ${label}`, count, w);
    lines.push({ text, style: selectionStyle(selected, focusSidebar) });
  });

  lines.push(blank(w));
  lines.push(sl(" " + "─".repeat(Math.max(0, w - 2)), w, { dim: true }));
  lines.push(sl(" Agents", w, { dim: true }));

  state.nav.forEach((item: NavItem, idx) => {
    if (item.kind !== "agent") return;
    const agent = state.vm.agents.find((a) => a.id === item.id);
    if (!agent) return;
    const selected = idx === state.navIndex;
    const marker = selected ? ">" : " ";
    const label = truncate(agent.label, Math.max(0, w - 6));
    const text = twoCol(` ${marker} ${label}`, agent.mark, w);
    lines.push({ text, style: selectionStyle(selected, focusSidebar) });
  });

  // Pad to the full column height.
  while (lines.length < height) lines.push(blank(w));
  return lines.slice(0, height);
}
