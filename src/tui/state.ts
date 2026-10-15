/**
 * The TUI state model and its PURE reducer. `reduce(state, action)` never performs I/O
 * or touches the core — every memory mutation is an EFFECT action the app loop hands to
 * `data.ts`. Keeping this pure makes navigation, focus, search, modal flow and the
 * locked-preference invariant (spec §11) all unit-testable without a terminal.
 */
import type { ListRow, PreferenceVM, SectionKey, ViewModel } from "./types.ts";
import type { Transition } from "./data.ts";
import { listCapacity } from "./layout.ts";

export type Focus = "sidebar" | "list";

export type NavItem =
  | { kind: "section"; key: SectionKey }
  | { kind: "agent"; id: string };

export interface ActionItem {
  label: string;
  transition: Transition;
}

export type Modal =
  | { type: "help" }
  | { type: "confirm"; prompt: string; id: string; version: number }
  | { type: "actions"; items: ActionItem[]; index: number; id: string; version: number }
  | { type: "add"; rule: string; scope: "global" | "repo"; field: 0 | 1 };

export interface StatusMsg {
  text: string;
  kind: "info" | "error";
}

export interface AppState {
  vm: ViewModel;
  nav: NavItem[];
  navIndex: number;
  focus: Focus;
  listIndex: number;
  listOffset: number;
  /** null = inactive; otherwise the live substring filter for the active section. */
  search: string | null;
  detailOpen: boolean;
  modal: Modal | null;
  status: StatusMsg | null;
  size: { cols: number; rows: number };
  colors: boolean;
  quit: boolean;
}

export type Action =
  | { type: "quit" }
  | { type: "navMove"; delta: number }
  | { type: "navEdge"; edge: "top" | "bottom" }
  | { type: "focusToggle" }
  | { type: "inspect" }
  | { type: "back" }
  | { type: "refresh" }
  | { type: "openHelp" }
  | { type: "openAdd" }
  | { type: "openActions" }
  | { type: "openForget" }
  | { type: "searchStart" }
  | { type: "searchInput"; ch: string }
  | { type: "modalMove"; delta: number }
  | { type: "modalInput"; ch: string }
  | { type: "modalToggleScope" }
  | { type: "submitAdd" }
  | { type: "confirmForget" }
  | { type: "runTransition"; transition: Transition };

/** Actions whose outcome is a core mutation; the app loop runs these, not the reducer. */
export const EFFECT_ACTIONS = new Set<Action["type"]>([
  "refresh",
  "submitAdd",
  "confirmForget",
  "runTransition",
]);

export function isEffect(action: Action): boolean {
  return EFFECT_ACTIONS.has(action.type);
}

// ---- selectors --------------------------------------------------------------

export function activeNav(state: AppState): NavItem | null {
  return state.nav[state.navIndex] ?? null;
}

export function activeSectionKey(state: AppState): SectionKey | null {
  const nav = activeNav(state);
  return nav && nav.kind === "section" ? nav.key : null;
}

export function sectionByKey(state: AppState, key: SectionKey) {
  return state.vm.sections.find((s) => s.key === key) ?? null;
}

export function activeSection(state: AppState) {
  const key = activeSectionKey(state);
  return key ? sectionByKey(state, key) : null;
}

/** Rows for the active section, filtered by the live search query when active. */
export function visibleRows(state: AppState): ListRow[] {
  const section = activeSection(state);
  if (!section || !section.enabled) return [];
  if (state.search == null || state.search.length === 0) return section.rows;
  const q = state.search.toLowerCase();
  return section.rows.filter((r) => r.search.includes(q));
}

export function selectedRow(state: AppState): ListRow | null {
  const rows = visibleRows(state);
  return rows[state.listIndex] ?? null;
}

/** Whether up/down should move the list selection (vs. the sidebar nav). */
export function isListMode(state: AppState): boolean {
  const section = activeSection(state);
  if (!section) return false;
  return state.focus === "list" || state.search != null || state.detailOpen;
}

/**
 * The SAFE lifecycle actions offered for a preference row. A locked rule is never
 * given a one-selection Approve/Unlock here — honoring spec §11 that locked prefs must
 * not accidentally become mutable through a TUI shortcut.
 */
export function actionsFor(pref: PreferenceVM): ActionItem[] {
  switch (pref.status) {
    case "proposed":
    case "observed":
      return [
        { label: "Approve", transition: "approve" },
        { label: "Reject", transition: "reject" },
      ];
    case "approved":
      return [
        { label: "Lock", transition: "lock" },
        { label: "Reject", transition: "reject" },
      ];
    case "locked":
      return [{ label: "Reject", transition: "reject" }];
    default:
      return [];
  }
}

// ---- construction + reconciliation ------------------------------------------

export function buildNav(vm: ViewModel): NavItem[] {
  return [
    ...vm.sections.map((s): NavItem => ({ kind: "section", key: s.key })),
    ...vm.agents.map((a): NavItem => ({ kind: "agent", id: a.id })),
  ];
}

export interface InitOptions {
  size: { cols: number; rows: number };
  colors: boolean;
}

export function initState(vm: ViewModel, opts: InitOptions): AppState {
  return {
    vm,
    nav: buildNav(vm),
    navIndex: 0,
    focus: "sidebar",
    listIndex: 0,
    listOffset: 0,
    search: null,
    detailOpen: false,
    modal: null,
    status: null,
    size: opts.size,
    colors: opts.colors,
    quit: false,
  };
}

function clampListWindow(state: AppState): AppState {
  const rows = visibleRows(state);
  const cap = listCapacity(state.size);
  let index = Math.min(Math.max(0, state.listIndex), Math.max(0, rows.length - 1));
  let offset = state.listOffset;
  if (index < offset) offset = index;
  else if (index >= offset + cap) offset = index - cap + 1;
  offset = Math.max(0, Math.min(offset, Math.max(0, rows.length - cap)));
  return { ...state, listIndex: index, listOffset: offset };
}

/**
 * Re-seat the UI onto a freshly-rebuilt view-model (after any mutation). Keeps the same
 * nav selection, re-targets the selected list row by id when still present, and clamps
 * every index — so a delete/approve never leaves the cursor pointing off the end.
 */
export function withViewModel(state: AppState, vm: ViewModel, keepRowId?: string): AppState {
  const nav = buildNav(vm);
  const navIndex = Math.min(state.navIndex, Math.max(0, nav.length - 1));
  let next: AppState = { ...state, vm, nav, navIndex };
  if (keepRowId) {
    const rows = visibleRows(next);
    const found = rows.findIndex((r) => r.id === keepRowId);
    if (found >= 0) next = { ...next, listIndex: found };
  }
  return clampListWindow(next);
}

/** Jump to a section by key (used after `add` to reveal the new preference). */
export function focusSection(state: AppState, key: SectionKey): AppState {
  const idx = state.nav.findIndex((n) => n.kind === "section" && n.key === key);
  if (idx < 0) return state;
  return { ...state, navIndex: idx, focus: "list", detailOpen: false, search: null };
}

// ---- the reducer ------------------------------------------------------------

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "quit":
      return { ...state, quit: true };

    case "navMove": {
      if (isListMode(state)) {
        const rows = visibleRows(state);
        if (rows.length === 0) return state;
        const listIndex = Math.min(Math.max(0, state.listIndex + action.delta), rows.length - 1);
        return clampListWindow({ ...state, listIndex, status: null });
      }
      const navIndex = Math.min(Math.max(0, state.navIndex + action.delta), state.nav.length - 1);
      if (navIndex === state.navIndex) return state;
      return {
        ...state,
        navIndex,
        listIndex: 0,
        listOffset: 0,
        detailOpen: false,
        search: null,
        status: null,
      };
    }

    case "navEdge": {
      if (isListMode(state)) {
        const rows = visibleRows(state);
        if (rows.length === 0) return state;
        const listIndex = action.edge === "top" ? 0 : rows.length - 1;
        return clampListWindow({ ...state, listIndex, status: null });
      }
      const navIndex = action.edge === "top" ? 0 : state.nav.length - 1;
      return { ...state, navIndex, listIndex: 0, listOffset: 0, detailOpen: false, search: null };
    }

    case "focusToggle": {
      const section = activeSection(state);
      if (!section) return state; // agent nav: nothing to focus into
      if (state.focus === "list") {
        return { ...state, focus: "sidebar", detailOpen: false, search: null, status: null };
      }
      if (section.rows.length === 0) return state; // nothing to focus (empty / vector)
      return clampListWindow({ ...state, focus: "list", status: null });
    }

    case "inspect": {
      const nav = activeNav(state);
      if (!nav || nav.kind === "agent") return state;
      const section = activeSection(state);
      if (!section || !section.enabled || section.rows.length === 0) return state;
      if (state.focus === "sidebar") {
        const next = clampListWindow({ ...state, focus: "list" });
        return selectedRow(next) ? { ...next, detailOpen: true } : next;
      }
      return selectedRow(state) ? { ...state, detailOpen: true } : state;
    }

    case "back": {
      if (state.modal) return { ...state, modal: null, status: null };
      if (state.search != null) return { ...state, search: null, listIndex: 0, listOffset: 0 };
      if (state.detailOpen) return { ...state, detailOpen: false };
      if (state.focus === "list") return { ...state, focus: "sidebar" };
      return state;
    }

    case "openHelp":
      return { ...state, modal: { type: "help" } };

    case "openAdd":
      return { ...state, modal: { type: "add", rule: "", scope: "global", field: 0 }, status: null };

    case "openActions": {
      const row = selectedRow(state);
      const key = activeSectionKey(state);
      if (!row || row.data.kind !== "preference" || (key !== "preferences" && key !== "proposals")) {
        return { ...state, status: { text: "No editable item selected.", kind: "info" } };
      }
      const items = actionsFor(row.data);
      if (items.length === 0) {
        return { ...state, status: { text: "No actions available for this item.", kind: "info" } };
      }
      return {
        ...state,
        modal: { type: "actions", items, index: 0, id: row.data.id, version: row.data.version },
      };
    }

    case "openForget": {
      const row = selectedRow(state);
      const key = activeSectionKey(state);
      if (!row || row.data.kind !== "preference" || (key !== "preferences" && key !== "proposals")) {
        return { ...state, status: { text: "Select a preference to forget.", kind: "info" } };
      }
      const preview = row.title.length > 48 ? row.title.slice(0, 47) + "…" : row.title;
      return {
        ...state,
        modal: {
          type: "confirm",
          prompt: `Forget this preference?\n${preview}`,
          id: row.data.id,
          version: row.data.version,
        },
      };
    }

    case "searchStart": {
      const section = activeSection(state);
      if (!section || !section.enabled) {
        return { ...state, status: { text: "Search is available in list views.", kind: "info" } };
      }
      return { ...state, search: "", focus: "list", detailOpen: false, listIndex: 0, listOffset: 0 };
    }

    case "searchInput": {
      if (state.search == null) return state;
      let q = state.search;
      if (action.ch === "\b") q = q.slice(0, -1);
      else q += action.ch;
      return clampListWindow({ ...state, search: q, listIndex: 0, listOffset: 0 });
    }

    case "modalMove": {
      const m = state.modal;
      if (!m) return state;
      if (m.type === "actions") {
        const index = Math.min(Math.max(0, m.index + action.delta), m.items.length - 1);
        return { ...state, modal: { ...m, index } };
      }
      if (m.type === "add") {
        const field = (m.field === 0 ? 1 : 0) as 0 | 1;
        return { ...state, modal: { ...m, field } };
      }
      return state;
    }

    case "modalInput": {
      const m = state.modal;
      if (!m || m.type !== "add" || m.field !== 0) return state;
      let rule = m.rule;
      if (action.ch === "\b") rule = rule.slice(0, -1);
      else rule += action.ch;
      return { ...state, modal: { ...m, rule } };
    }

    case "modalToggleScope": {
      const m = state.modal;
      if (!m || m.type !== "add") return state;
      return { ...state, modal: { ...m, scope: m.scope === "global" ? "repo" : "global" } };
    }

    // Effect actions are handled by the app loop; reducing them is a no-op safeguard.
    case "refresh":
    case "submitAdd":
    case "confirmForget":
    case "runTransition":
      return state;

    default:
      return state;
  }
}

/** Apply a terminal resize, re-clamping the list window to the new height. */
export function resize(state: AppState, size: { cols: number; rows: number }): AppState {
  return clampListWindow({ ...state, size });
}

/** Set (or clear) the transient footer status message. */
export function setStatus(state: AppState, status: StatusMsg | null): AppState {
  return { ...state, status };
}
