/**
 * Shared view-model + UI types for the interactive TUI (`ctx` with no args on a TTY).
 *
 * HARD INVARIANT (spec §6): NO memory business logic lives in the TUI. Everything in
 * this layer is state, input, rendering and orchestration. The view-model here is a
 * flat, render-friendly PROJECTION of the core services' output — produced by
 * `data.ts`, which is the only TUI module that touches `CtxContext`. The renderer and
 * reducers never import core services, so a future memory source (e.g. a vector tier)
 * can populate another `SectionVM` without any renderer change (spec §15).
 */

/** The browsable memory sections. `vector` is an honest, not-yet-enabled placeholder. */
export type SectionKey = "preferences" | "signals" | "proposals" | "vector";

/** A rendered preference/proposal, flattened for the list + detail views. */
export interface PreferenceVM {
  kind: "preference";
  id: string;
  rule: string;
  scope: string;
  status: string;
  applicability: string;
  domain: string | null;
  category: string;
  polarity: string;
  confidence: number;
  version: number;
  repoName: string | null;
  condition: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  /** Proposals carry their accumulated evidence count; approved rules usually 0-shown. */
  evidenceCount: number;
  evidence: { source: string; agentId: string | null; text: string; at: string }[];
}

/** A rendered decision signal (non-authoritative evidence — never a preference). */
export interface SignalVM {
  kind: "signal";
  id: string;
  domain: string;
  choice: string;
  repoName: string | null;
  context: string | null;
  isException: boolean;
  preferredChoice: string | null;
  reason: string | null;
  constraint: string | null;
  source: string;
  createdAt: string;
}

export type RowData = PreferenceVM | SignalVM;

/** A single selectable list row, with a precomputed lowercased haystack for search. */
export interface ListRow {
  id: string;
  title: string;
  meta: string;
  /** A small leading badge/marker drawn before the title (e.g. status glyph). */
  badge: string;
  search: string;
  data: RowData;
}

export interface SectionVM {
  key: SectionKey;
  label: string;
  rows: ListRow[];
  /** False for the Vector Memory placeholder: the pane renders honest "not enabled" copy. */
  enabled: boolean;
  /** Shown when `enabled` and `rows` is empty (good first-launch empty states, spec §17). */
  emptyText: string[];
  /** Shown when `!enabled` (the Vector Memory placeholder copy, spec §14). */
  placeholder: string[];
}

export interface AgentVM {
  id: string;
  label: string;
  /** Compact status glyph for the sidebar (✓ / ! / · / x). */
  mark: string;
  /** Honest status label derived from real detection (spec §16). */
  statusLabel: string;
  detected: boolean;
  installed: boolean;
  healthy: boolean;
  configPath: string;
  capabilities: string[];
  notes: string[];
}

export interface ViewModel {
  repoLabel: string;
  version: string;
  /** Ordered for sidebar display. */
  sections: SectionVM[];
  agents: AgentVM[];
}
