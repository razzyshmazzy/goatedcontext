import { canonicalDomain } from "../signals/domains.ts";
import { type ActivationSpec, matchActivation, type RelevanceState } from "./activation.ts";
import { CandidateIndex } from "./candidate-index.ts";
import { type AgentEvent } from "./event.ts";
import { extractFeatures } from "./features.ts";
import { DEFAULT_LEDGER_CONFIG, DeliveryLedger, type LedgerConfig } from "./ledger.ts";
import { type ObligationState, TemporalMachine, type TemporalRule } from "./temporal.ts";
import type { Operation } from "./vocab.ts";
import {
  DEFAULT_WORKFLOW_CONFIG,
  WorkflowState,
  type WorkflowStateConfig,
} from "./workflow-state.ts";

/**
 * A memory paired with its OPTIONAL activation spec. The natural-language `rule`
 * stays authoritative; `spec` is only the runtime trigger (§5). `spec.repo` or
 * `repoScope` restrict a repo-scoped memory to its repo.
 */
export interface ActivatedMemory {
  id: string;
  rule: string;
  domain?: string | null;
  scope?: "global" | "repo";
  repo?: string | null;
  spec: ActivationSpec;
  /** Optional temporal obligation linked to this memory (§17). */
  temporal?: { triggerOps: Operation[]; satisfyOps: Operation[] };
}

export interface OverseerConfig {
  /** Use bounded recent-domain history to activate same-domain memories (§11). */
  useWorkflowState: boolean;
  /** Use the decaying domain-activation field to activate memories (§12). */
  useDecay: boolean;
  workflow: WorkflowStateConfig;
  ledger: LedgerConfig;
}

export const DEFAULT_OVERSEER_CONFIG: OverseerConfig = {
  useWorkflowState: false,
  useDecay: false,
  workflow: DEFAULT_WORKFLOW_CONFIG,
  ledger: DEFAULT_LEDGER_CONFIG,
};

export type DeliveryVia = "activation" | "workflow" | "decay" | "temporal";

export interface Delivery {
  id: string;
  rule: string;
  state: RelevanceState;
  via: DeliveryVia;
  reason: string;
  relevanceHits: string[];
  renderedChars: number;
}

export interface EvaluatedMemory {
  id: string;
  state: RelevanceState;
  conflict: boolean;
  via: DeliveryVia;
  reason: string;
  relevanceHits: string[];
}

export interface OverseerObservation {
  seq: number;
  phase: string;
  /** Flat sparse feature tags of this event (for dataset rows). */
  features: string[];
  /** Candidate memory ids produced by the inverted index (+ workflow expansion). */
  candidates: string[];
  candidateCount: number;
  evaluated: EvaluatedMemory[];
  deliveries: Delivery[];
  obligations: ObligationState[];
  /** Wall-clock evaluation time for this event, in milliseconds. */
  elapsedMs: number;
}

const PER_DELIVERY_OVERHEAD = 12; // approx chars for the "[state] … — reason" framing

/** Approx rendered size of a single delivered memory (used for injected-chars metric). */
function renderedChars(rule: string): number {
  return Math.min(rule.length, 500) + PER_DELIVERY_OVERHEAD;
}

/**
 * The host-INDEPENDENT overseer. It observes a stream of normalized AgentEvents and
 * emits newly-relevant context deliveries. No "claude" assumptions live here; a host
 * adapter feeds it AgentEvents. It never writes authoritative memory.
 */
export class Overseer {
  private readonly byId = new Map<string, ActivatedMemory>();
  private readonly index = new CandidateIndex();
  private readonly workflow: WorkflowState;
  private readonly ledger: DeliveryLedger;
  private readonly temporal: TemporalMachine;
  private readonly config: OverseerConfig;
  private readonly currentRepo: string | null;

  constructor(
    memories: ActivatedMemory[],
    opts: { config?: Partial<OverseerConfig>; currentRepo?: string | null; temporalRules?: TemporalRule[] } = {},
  ) {
    this.config = {
      ...DEFAULT_OVERSEER_CONFIG,
      ...opts.config,
      workflow: { ...DEFAULT_WORKFLOW_CONFIG, ...(opts.config?.workflow ?? {}), useDecay: opts.config?.useDecay ?? false },
      ledger: { ...DEFAULT_LEDGER_CONFIG, ...(opts.config?.ledger ?? {}) },
    };
    this.currentRepo = opts.currentRepo ?? null;
    for (const m of memories) {
      this.byId.set(m.id, m);
      this.index.add(m.id, m.spec);
    }
    this.workflow = new WorkflowState(this.config.workflow);
    this.ledger = new DeliveryLedger(this.config.ledger);
    const derived: TemporalRule[] = memories
      .filter((m) => m.temporal)
      .map((m) => ({ id: m.id, rule: m.rule, triggerOps: m.temporal!.triggerOps, satisfyOps: m.temporal!.satisfyOps }));
    this.temporal = new TemporalMachine([...(opts.temporalRules ?? []), ...derived]);
  }

  /** True when a repo-scoped memory applies in the current repo. */
  private inScope(m: ActivatedMemory): boolean {
    const scopeRepo = m.spec.repo ?? (m.scope === "repo" ? (m.repo ?? null) : null);
    if (!scopeRepo) return true;
    return this.currentRepo != null && scopeRepo === this.currentRepo;
  }

  /** Observe one event and return the resulting deliveries + diagnostics. */
  observe(event: AgentEvent): OverseerObservation {
    const start = performance.now();
    const f = extractFeatures(event);
    if (this.config.useWorkflowState || this.config.useDecay) this.workflow.observe(f);
    this.temporal.observe(f, event.seq);

    const candidates = this.index.candidates(f);
    if (this.config.useWorkflowState) {
      for (const d of this.workflow.recentDomains.values()) for (const id of this.index.byDomain(d)) candidates.add(id);
    }
    if (this.config.useDecay) {
      for (const d of this.workflow.activeDomains()) for (const id of this.index.byDomain(d)) candidates.add(id);
    }

    const evaluated: EvaluatedMemory[] = [];
    for (const id of candidates) {
      const mem = this.byId.get(id);
      if (!mem || !this.inScope(mem)) continue;
      const m = matchActivation(mem.spec, f);
      let state: RelevanceState = m.state;
      let via: DeliveryVia = "activation";
      let reason = m.reason;
      let hits = m.relevanceHits;

      if (state === "irrelevant" && (this.config.useWorkflowState || this.config.useDecay)) {
        for (const raw of mem.spec.domains ?? []) {
          const cd = canonicalDomain(raw);
          if (this.config.useDecay && this.workflow.activationOf(cd) >= this.config.workflow.decayThreshold) {
            state = "relevant";
            via = "decay";
            reason = `domain ${cd} active (decay ${this.workflow.activationOf(cd).toFixed(2)})`;
            hits = [`domain:${cd}(decay)`];
            break;
          }
          if (this.config.useWorkflowState && this.workflow.recentDomains.has(cd)) {
            state = "relevant";
            via = "workflow";
            reason = `domain ${cd} recently active`;
            hits = [`domain:${cd}(recent)`];
            break;
          }
        }
      }

      if (state !== "irrelevant") {
        evaluated.push({ id, state, conflict: state === "conflict", via, reason, relevanceHits: hits });
      }
    }

    // Deterministic order: conflicts first, then by id.
    evaluated.sort((a, b) => {
      if (a.conflict !== b.conflict) return a.conflict ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const deliveries: Delivery[] = [];
    for (const e of evaluated) {
      const dec = this.ledger.shouldDeliver(e.id, e.state, event.seq);
      if (!dec.deliver) continue;
      this.ledger.record(e.id, e.state, event.seq, dec.reason);
      const mem = this.byId.get(e.id)!;
      deliveries.push({
        id: e.id,
        rule: mem.rule,
        state: e.state,
        via: e.via,
        reason: dec.reason,
        relevanceHits: e.relevanceHits,
        renderedChars: renderedChars(mem.rule),
      });
    }

    // Temporal reminders fire on stop as conflict-strength deliveries.
    if (event.phase === "stop") {
      for (const r of this.temporal.unresolved()) {
        const dec = this.ledger.shouldDeliver(r.id, "conflict", event.seq);
        if (!dec.deliver) continue;
        this.ledger.record(r.id, "conflict", event.seq, "temporal obligation unresolved");
        deliveries.push({
          id: r.id,
          rule: r.rule,
          state: "conflict",
          via: "temporal",
          reason: r.reason,
          relevanceHits: ["temporal"],
          renderedChars: renderedChars(r.rule),
        });
      }
    }

    return {
      seq: event.seq,
      phase: event.phase,
      features: [...f.tags].sort(),
      candidates: [...candidates].sort(),
      candidateCount: candidates.size,
      evaluated,
      deliveries,
      obligations: this.temporal.obligations(),
      elapsedMs: performance.now() - start,
    };
  }

  /** Current ledger entries (diagnostics only). */
  ledgerEntries() {
    return this.ledger.all();
  }

  /** Current workflow-state snapshot (diagnostics only). */
  workflowSnapshot() {
    return this.workflow.snapshot();
  }

  get indexStats(): { memories: number; keys: number } {
    return { memories: this.index.size, keys: this.index.keyCount };
  }
}
