/**
 * The navigation column, rendered as two stacked panels — "Memory" (the four sections
 * with counts) and "Agents" (detected integrations with a status glyph). The selected
 * row shows a full-width accent bar when the sidebar is focused, and a dimmer accent
 * marker when it isn't, so the user never loses their place but always knows which pane
 * is live (spec §16 / UX pattern #7). A leading "›" marks selection even with color off.
 */
import type { AppState, NavItem } from "../state.ts";
import { sectionByKey } from "../state.ts";
import { type PanelLine, type Role, type Span, span, truncate, width } from "../layout.ts";

function row(
  label: string,
  right: string,
  rightRole: Role | "dim",
  innerW: number,
  selected: boolean,
  sidebarFocused: boolean,
): PanelLine {
  const marker = selected ? "› " : "  ";
  const barOn = selected && sidebarFocused;
  const labelStyle = selected
    ? { bold: true as const, fg: (barOn ? "onAccent" : "accent") as Role }
    : {};
  const rightStyle = barOn
    ? { fg: "onAccent" as Role }
    : rightRole === "dim"
      ? { dim: true as const }
      : { fg: rightRole };

  const labelText = truncate(marker + label, Math.max(0, innerW - width(right) - 1));
  const gap = Math.max(0, innerW - width(labelText) - width(right));
  const spans: Span[] = [
    span(" " + labelText, labelStyle),
    span(" ".repeat(gap)),
    span(right + " ", rightStyle),
  ];
  return { spans, bg: barOn ? "accent" : undefined };
}

export function memoryRows(state: AppState, innerW: number): PanelLine[] {
  const focused = state.focus === "sidebar";
  const out: PanelLine[] = [];
  state.nav.forEach((item: NavItem, idx) => {
    if (item.kind !== "section") return;
    const section = sectionByKey(state, item.key);
    if (!section) return;
    const count = section.enabled ? String(section.rows.length) : "—";
    out.push(row(section.label, count, "dim", innerW, idx === state.navIndex, focused));
  });
  return out;
}

export function agentRows(state: AppState, innerW: number): PanelLine[] {
  const focused = state.focus === "sidebar";
  const out: PanelLine[] = [];
  state.nav.forEach((item: NavItem, idx) => {
    if (item.kind !== "agent") return;
    const agent = state.vm.agents.find((a) => a.id === item.id);
    if (!agent) return;
    const role: Role | "dim" = agent.healthy
      ? "success"
      : agent.installed
        ? "warning"
        : "dim";
    out.push(row(agent.label, agent.mark, role, innerW, idx === state.navIndex, focused));
  });
  return out;
}
