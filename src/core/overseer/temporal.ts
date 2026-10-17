import type { EventFeatures } from "./features.ts";
import type { Operation } from "./vocab.ts";

/**
 * EXPERIMENTAL temporal-rule state machine (§17).
 *
 * Some preferences are obligations across time rather than point-in-time matches:
 * "Run tests after changing database migrations." A migration edit opens a PENDING
 * obligation; a test run satisfies it; reaching `stop` with the obligation still
 * pending is an unresolved conflict/reminder. This is a deliberately tiny automaton,
 * not a temporal DSL — it exists to test whether automata are a better fit than
 * retrieval rules for this class of preference.
 */
export interface TemporalRule {
  /** The memory id this obligation is linked to (shares the rule text). */
  id: string;
  rule: string;
  /** Operations that OPEN the obligation. */
  triggerOps: Operation[];
  /** Operations that SATISFY (close) the obligation. */
  satisfyOps: Operation[];
}

export interface ObligationState {
  id: string;
  rule: string;
  pending: boolean;
  openedAtSeq: number | null;
  satisfiedAtSeq: number | null;
}

export interface TemporalReminder {
  id: string;
  rule: string;
  reason: string;
}

export class TemporalMachine {
  private readonly rules: TemporalRule[];
  private readonly state = new Map<string, ObligationState>();

  constructor(rules: TemporalRule[]) {
    this.rules = rules;
    for (const r of rules) {
      this.state.set(r.id, { id: r.id, rule: r.rule, pending: false, openedAtSeq: null, satisfiedAtSeq: null });
    }
  }

  /** Advance the automaton with one event's operations. */
  observe(f: EventFeatures, seq: number): void {
    for (const r of this.rules) {
      const s = this.state.get(r.id)!;
      if (r.satisfyOps.some((o) => f.operations.has(o))) {
        if (s.pending) {
          s.pending = false;
          s.satisfiedAtSeq = seq;
        }
      }
      if (r.triggerOps.some((o) => f.operations.has(o))) {
        s.pending = true;
        s.openedAtSeq = seq;
        s.satisfiedAtSeq = null;
      }
    }
  }

  /** Obligations still pending — emitted as reminders at `stop`. */
  unresolved(): TemporalReminder[] {
    const out: TemporalReminder[] = [];
    for (const s of this.state.values()) {
      if (s.pending) {
        out.push({ id: s.id, rule: s.rule, reason: `obligation opened at event #${s.openedAtSeq} never satisfied` });
      }
    }
    return out;
  }

  obligations(): ObligationState[] {
    return [...this.state.values()].map((s) => ({ ...s }));
  }
}
