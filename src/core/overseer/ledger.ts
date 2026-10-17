import type { RelevanceState } from "./activation.ts";

/**
 * The per-session DELIVERY LEDGER (§13).
 *
 * Tracks what has already been surfaced so the overseer stays SPARSE and does not
 * re-inject the same memory on every hook. Redelivery is allowed only when a
 * conflict newly appears or a conflict persists past a gap; a plain relevance is
 * delivered once. The ledger is per-session and purely in-memory — nothing here is
 * a persisted preference (§26).
 */
export interface LedgerEntry {
  memoryId: string;
  lastDeliveredSeq: number;
  deliveryCount: number;
  lastReason: string;
  lastState: RelevanceState;
}

export interface DeliveryDecision {
  deliver: boolean;
  reason: string;
}

export interface LedgerConfig {
  /** Min events between repeated conflict surfacings of the same memory. */
  conflictGap: number;
  /** Min events between repeated plain-relevance surfacings (high = once). */
  relevanceGap: number;
}

export const DEFAULT_LEDGER_CONFIG: LedgerConfig = {
  conflictGap: 4,
  relevanceGap: Number.POSITIVE_INFINITY,
};

export class DeliveryLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  constructor(private readonly config: LedgerConfig = DEFAULT_LEDGER_CONFIG) {}

  get(id: string): LedgerEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Decide whether to deliver `id` in state `state` at `seq`, per the §14 policy.
   * Pure — does NOT mutate; call `record` after an actual delivery.
   */
  shouldDeliver(id: string, state: RelevanceState, seq: number): DeliveryDecision {
    if (state === "irrelevant") return { deliver: false, reason: "irrelevant" };
    const prev = this.entries.get(id);
    if (!prev) {
      return { deliver: true, reason: state === "conflict" ? "first conflict" : "first relevant" };
    }
    if (state === "conflict") {
      if (prev.lastState !== "conflict") return { deliver: true, reason: "conflict newly appeared" };
      if (seq - prev.lastDeliveredSeq >= this.config.conflictGap) {
        return { deliver: true, reason: "conflict persists past gap" };
      }
      return { deliver: false, reason: "conflict recently surfaced" };
    }
    // state === "relevant"
    if (prev.lastState === "conflict") return { deliver: false, reason: "already surfaced (as conflict)" };
    if (seq - prev.lastDeliveredSeq >= this.config.relevanceGap) {
      return { deliver: true, reason: "relevance persists past gap" };
    }
    return { deliver: false, reason: "already delivered (relevant)" };
  }

  /** Record an actual delivery. */
  record(id: string, state: RelevanceState, seq: number, reason: string): void {
    const prev = this.entries.get(id);
    this.entries.set(id, {
      memoryId: id,
      lastDeliveredSeq: seq,
      deliveryCount: (prev?.deliveryCount ?? 0) + 1,
      lastReason: reason,
      lastState: state,
    });
  }

  all(): LedgerEntry[] {
    return [...this.entries.values()];
  }
}
