import type { EventFeatures } from "./features.ts";

/**
 * A very small, BOUNDED per-session workflow state (§11) plus an optional decaying
 * domain-activation field (§12).
 *
 * This stores only things with clear value — recent domains, files, operations, and
 * a decaying activation score per domain — all bounded. It is NOT a transcript and
 * holds no file contents. The decay field is isolated behind a flag so it can be
 * benchmarked against stateless matching.
 */
export interface WorkflowStateConfig {
  /** Bounded recent-history length (default 8). */
  historyLimit: number;
  /** Whether to maintain the decaying domain-activation field. */
  useDecay: boolean;
  /** Multiplicative decay per event: next = old * lambda + delta. */
  decayLambda: number;
  /** Additive bump when a domain appears in an event. */
  decayDelta: number;
  /** Activation level above which a domain counts as "active". */
  decayThreshold: number;
}

export const DEFAULT_WORKFLOW_CONFIG: WorkflowStateConfig = {
  historyLimit: 8,
  useDecay: false,
  decayLambda: 0.6,
  decayDelta: 0.5,
  decayThreshold: 0.35,
};

/** A fixed-capacity most-recent-first ring of distinct values. */
class BoundedRecent<T> {
  private readonly items: T[] = [];
  constructor(private readonly limit: number) {}
  push(v: T): void {
    const i = this.items.indexOf(v);
    if (i >= 0) this.items.splice(i, 1);
    this.items.unshift(v);
    if (this.items.length > this.limit) this.items.length = this.limit;
  }
  values(): T[] {
    return [...this.items];
  }
  has(v: T): boolean {
    return this.items.includes(v);
  }
}

export class WorkflowState {
  readonly recentDomains: BoundedRecent<string>;
  readonly recentFiles: BoundedRecent<string>;
  readonly recentOperations: BoundedRecent<string>;
  private readonly activation = new Map<string, number>();
  private eventCount = 0;

  constructor(private readonly config: WorkflowStateConfig = DEFAULT_WORKFLOW_CONFIG) {
    this.recentDomains = new BoundedRecent(config.historyLimit);
    this.recentFiles = new BoundedRecent(config.historyLimit);
    this.recentOperations = new BoundedRecent(config.historyLimit);
  }

  /** Fold one event's features into bounded history and the decay field. */
  observe(f: EventFeatures): void {
    this.eventCount++;
    for (const d of f.domains) this.recentDomains.push(d);
    for (const p of f.files) this.recentFiles.push(p);
    for (const o of f.operations) this.recentOperations.push(o);

    if (this.config.useDecay) {
      // Decay every tracked domain first, then bump the ones present this event.
      for (const [d, v] of this.activation) {
        const next = v * this.config.decayLambda;
        if (next < 0.01) this.activation.delete(d);
        else this.activation.set(d, next);
      }
      for (const d of f.domains) {
        this.activation.set(d, (this.activation.get(d) ?? 0) * this.config.decayLambda + this.config.decayDelta);
      }
    }
  }

  /** Canonical domains whose decaying activation is currently above threshold. */
  activeDomains(): string[] {
    if (!this.config.useDecay) return [];
    const out: string[] = [];
    for (const [d, v] of this.activation) if (v >= this.config.decayThreshold) out.push(d);
    return out;
  }

  /** The current activation level of a domain (0 when untracked). */
  activationOf(domain: string): number {
    return this.activation.get(domain) ?? 0;
  }

  snapshot(): {
    events: number;
    recentDomains: string[];
    recentFiles: string[];
    recentOperations: string[];
    activation: Record<string, number>;
  } {
    return {
      events: this.eventCount,
      recentDomains: this.recentDomains.values(),
      recentFiles: this.recentFiles.values(),
      recentOperations: this.recentOperations.values(),
      activation: Object.fromEntries([...this.activation].map(([k, v]) => [k, Number(v.toFixed(3))])),
    };
  }
}
