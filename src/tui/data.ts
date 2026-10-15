/**
 * The TUI's ONLY bridge to the core. Every read here is a projection of an existing
 * service call, and every write delegates to the SAME service method the CLI uses — so
 * the TUI can never diverge from CLI semantics or re-implement memory logic (spec §6).
 *
 *   add preference     -> PreferenceService.remember   (human path, origin=user)
 *   forget preference  -> PreferenceService.forget      (CAS via expectedVersion)
 *   approve/reject/lock -> PreferenceService.transition (CAS via expectedVersion)
 *
 * This module is also the interface seam of spec §15: `buildViewModel` assembles the
 * sidebar sections from whatever sources exist today (SQLite-backed services) plus an
 * honest Vector Memory placeholder. A future memory tier adds another `SectionVM` here
 * without touching the reducer or renderer.
 */
import type { CtxContext } from "../core/context.ts";
import type { Preference } from "../core/preferences/types.ts";
import type { Signal } from "../core/signals/service.ts";
import { agentStatuses } from "../core/agents/registry.ts";
import { compactCondition } from "../core/preferences/conditions.ts";
import { shortId } from "../utils/id.ts";
import { VERSION } from "../version.ts";
import type {
  AgentVM,
  ListRow,
  PreferenceVM,
  SectionVM,
  SignalVM,
  ViewModel,
} from "./types.ts";

export interface BuildOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  claudeHome?: string;
  codexHome?: string;
  cursorHome?: string;
}

const APPROVED = new Set(["approved", "locked"]);
const PENDING = new Set(["proposed", "observed"]);

function prefToVM(ctx: CtxContext, p: Preference): PreferenceVM {
  const evidence = ctx.preferences.evidenceFor(p.id);
  return {
    kind: "preference",
    id: p.id,
    rule: p.rule,
    scope: p.scope,
    status: p.status,
    applicability: p.applicability,
    domain: p.domain,
    category: p.category,
    polarity: p.polarity,
    confidence: p.confidence,
    version: p.version,
    repoName: p.repoId ? ctx.repos.getById(p.repoId)?.name ?? null : null,
    condition: p.condition ? compactCondition(p.condition) : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    lastUsedAt: p.lastUsedAt,
    evidenceCount: evidence.length,
    evidence: evidence.map((e) => ({
      source: e.source,
      agentId: e.agentId,
      text: e.evidenceText,
      at: e.createdAt,
    })),
  };
}

function signalToVM(ctx: CtxContext, s: Signal): SignalVM {
  return {
    kind: "signal",
    id: s.id,
    domain: s.domain,
    choice: s.choiceRaw,
    repoName: s.repoId ? ctx.repos.getById(s.repoId)?.name ?? null : null,
    context: s.context,
    isException: s.isException,
    preferredChoice: s.preferredChoice,
    reason: s.reason,
    constraint: s.constraintTag,
    source: s.source,
    createdAt: s.createdAt,
  };
}

/** Single-column status glyph for a preference/proposal row (keeps titles aligned). */
function statusBadge(status: string): string {
  switch (status) {
    case "locked":
      return "◆";
    case "approved":
      return "●";
    case "proposed":
    case "observed":
      return "○";
    default:
      return "·";
  }
}

function prefRow(p: PreferenceVM): ListRow {
  const scopeRepo = p.scope === "repo" ? `repo${p.repoName ? `:${p.repoName}` : ""}` : "global";
  const bits = [scopeRepo, p.status];
  if (p.domain) bits.push(p.domain);
  if (p.applicability !== "relevant") bits.push(p.applicability);
  return {
    id: p.id,
    title: p.rule,
    meta: bits.join(" · "),
    badge: statusBadge(p.status),
    search: `${p.rule} ${scopeRepo} ${p.status} ${p.domain ?? ""} ${p.category}`.toLowerCase(),
    data: p,
  };
}

function proposalRow(p: PreferenceVM): ListRow {
  const scopeRepo = p.scope === "repo" ? `repo${p.repoName ? `:${p.repoName}` : ""}` : "global";
  const meta = `${scopeRepo} · ${p.status} · conf ${p.confidence.toFixed(2)} · evidence ${p.evidenceCount}`;
  return {
    id: p.id,
    title: p.rule,
    meta,
    badge: "○",
    search: `${p.rule} ${scopeRepo} ${p.domain ?? ""}`.toLowerCase(),
    data: p,
  };
}

function signalRow(s: SignalVM): ListRow {
  const where = s.repoName ? `repo:${s.repoName}` : "cross-repo";
  const exc = s.isException ? " · exception" : "";
  return {
    id: s.id,
    title: `${s.domain} = ${s.choice}`,
    meta: `${where} · ${s.source}${exc} · ${s.createdAt.slice(0, 10)}`,
    badge: s.isException ? "!" : "·",
    search: `${s.domain} ${s.choice} ${s.reason ?? ""} ${where}`.toLowerCase(),
    data: s,
  };
}

function agentToVM(s: ReturnType<typeof agentStatuses>[number]): AgentVM {
  const mark = s.healthy ? "✓" : s.installed ? "!" : s.detected ? "·" : "×";
  const statusLabel = s.healthy
    ? "healthy"
    : s.installed
      ? "needs repair"
      : s.detected
        ? "detected"
        : "not installed";
  const caps: string[] = [];
  if (s.capabilities.runtimePromptInjection) caps.push("runtime");
  else if (s.capabilities.sessionInjection) caps.push("session");
  if (s.capabilities.mcp) caps.push("mcp");
  if (s.capabilities.staticAgentsMd) caps.push("AGENTS.md");
  return {
    id: s.id,
    label: s.label,
    mark,
    statusLabel,
    detected: s.detected,
    installed: s.installed,
    healthy: s.healthy,
    configPath: s.configPath,
    capabilities: caps,
    notes: s.notes,
  };
}

/** Assemble the full view-model from the live services (spec §15 interface seam). */
export function buildViewModel(ctx: CtxContext, opts: BuildOptions): ViewModel {
  const repo = ctx.repos.resolve(opts.cwd);
  const all = ctx.preferences.list();

  const approved = all
    .filter((p) => APPROVED.has(p.status))
    .map((p) => prefRow(prefToVM(ctx, p)));
  const proposals = all
    .filter((p) => PENDING.has(p.status))
    .map((p) => proposalRow(prefToVM(ctx, p)));
  const signals = ctx.signals.list().map((s) => signalRow(signalToVM(ctx, s)));

  const sections: SectionVM[] = [
    {
      key: "preferences",
      label: "Preferences",
      rows: approved,
      enabled: true,
      emptyText: [
        "No preferences yet.",
        "",
        "Tell your coding agent something durable,",
        "or press `a` to add one.",
      ],
      placeholder: [],
    },
    {
      key: "signals",
      label: "Signals",
      rows: signals,
      enabled: true,
      emptyText: [
        "No signals yet.",
        "",
        "Signals are observed decisions — evidence,",
        "never authoritative defaults.",
      ],
      placeholder: [],
    },
    {
      key: "proposals",
      label: "Proposals",
      rows: proposals,
      enabled: true,
      emptyText: ["No pending proposals."],
      placeholder: [],
    },
    {
      key: "vector",
      label: "Vector Memory",
      rows: [],
      enabled: false,
      emptyText: [],
      placeholder: [
        "Vector Memory",
        "",
        "Experimental memory tier. Not enabled yet.",
        "",
        "Structured preferences and signals remain",
        "the authoritative store.",
      ],
    },
  ];

  const agents = agentStatuses({
    env: opts.env,
    cwd: opts.cwd,
    claudeHome: opts.claudeHome,
    codexHome: opts.codexHome,
    cursorHome: opts.cursorHome,
  }).map(agentToVM);

  return {
    repoLabel: repo ? repo.name : "global",
    version: VERSION,
    sections,
    agents,
  };
}

// ---- write delegations (CLI-identical semantics; no new business logic) -----

export interface AddPreferenceInput {
  rule: string;
  scope: "global" | "repo";
  cwd: string;
}

/**
 * Add a preference via the SAME human `remember` path the CLI uses. Origin is the
 * developer's own action (`user`) because the TUI is a direct, interactive surface —
 * never an autonomous agent write. Repo scope resolves the repo at `cwd` and throws a
 * clean CtxError if there is none (surfaced to the user, not a crash).
 */
export function addPreference(ctx: CtxContext, input: AddPreferenceInput): Preference {
  let repoId: string | null = null;
  if (input.scope === "repo") {
    const repo = ctx.repos.resolve(input.cwd);
    if (!repo) {
      throw new Error("Repo scope needs a git repository at the current directory.");
    }
    repoId = repo.id;
  }
  return ctx.preferences.remember({
    rule: input.rule,
    scope: input.scope,
    repoId,
    status: "approved",
    source: "explicit",
    origin: "user",
  });
}

/** Forget a preference with the service's optimistic-concurrency guard (spec §12/§18). */
export function forgetPreference(ctx: CtxContext, id: string, version: number): void {
  ctx.preferences.forget(id, { expectedVersion: version });
}

export type Transition = "approve" | "reject" | "lock";

/**
 * Apply a lifecycle transition via the existing CAS service methods — the "safe update
 * semantics" of spec §12. `approve` on a locked/approved rule is a no-op in the service
 * (it never downgrades a lock), so a locked preference can never be silently unlocked
 * through the TUI (spec §11). `shortId` is only used for messages.
 */
export function transitionPreference(
  ctx: CtxContext,
  id: string,
  version: number,
  transition: Transition,
): string {
  const label = shortId(id);
  if (transition === "approve") ctx.preferences.approve(id, { expectedVersion: version });
  else if (transition === "reject") ctx.preferences.reject(id, { expectedVersion: version });
  else ctx.preferences.lock(id, { expectedVersion: version });
  return label;
}
