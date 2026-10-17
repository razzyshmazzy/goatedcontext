import { canonicalDomain } from "../signals/domains.ts";
import type { ActivationSpec } from "./activation.ts";
import type { EventFeatures } from "./features.ts";

/**
 * A cheap INVERTED ACTIVATION INDEX (§9).
 *
 * Maps a sparse feature key (e.g. `exe:npm`, `domain:database`, `op:test_run`) to
 * the set of memory ids whose activation spec references that key — on either its
 * relevance dimensions OR its conflict triggers (a conflict can fire on a feature
 * the relevance side never lists). Given an event's feature tags we union the
 * posting lists to get a small candidate set, then run the exact matcher on only
 * those. Two feature families cannot be inverted exactly and fall back to coarse
 * buckets: file globs (any memory with a glob is a candidate once the event touches
 * files) and token cues (indexed by `tok:<cue>`).
 */
export class CandidateIndex {
  private readonly postings = new Map<string, Set<string>>();
  private readonly fileGlobMemories = new Set<string>();
  private memoryCount = 0;

  private post(key: string, id: string): void {
    let set = this.postings.get(key);
    if (!set) {
      set = new Set<string>();
      this.postings.set(key, set);
    }
    set.add(id);
  }

  /** Index one memory's activation spec under every feature it could match on. */
  add(id: string, spec: ActivationSpec): void {
    this.memoryCount++;
    for (const d of spec.domains ?? []) this.post(`domain:${canonicalDomain(d)}`, id);
    for (const o of spec.operations ?? []) this.post(`op:${o}`, id);
    for (const t of spec.tools ?? []) this.post(`tool:${t}`, id);
    for (const e of spec.executables ?? []) this.post(`exe:${e}`, id);
    for (const l of spec.languages ?? []) this.post(`lang:${l}`, id);
    for (const p of spec.packages ?? []) this.post(`pkg:${p}`, id);
    for (const a of spec.artifacts ?? []) this.post(`artifact:${a}`, id);
    if (spec.files && spec.files.length) this.fileGlobMemories.add(id);
    for (const trig of spec.conflicts ?? []) {
      for (const o of trig.operations ?? []) this.post(`op:${o}`, id);
      for (const e of trig.executables ?? []) this.post(`exe:${e}`, id);
      for (const a of trig.artifacts ?? []) this.post(`artifact:${a}`, id);
      for (const p of trig.packages ?? []) this.post(`pkg:${p}`, id);
      for (const c of trig.tokens ?? []) this.post(`tok:${c}`, id);
      if (trig.files && trig.files.length) this.fileGlobMemories.add(id);
    }
  }

  /** Candidate memory ids for an event, by unioning posting lists. */
  candidates(f: EventFeatures): Set<string> {
    const out = new Set<string>();
    const add = (key: string) => {
      const set = this.postings.get(key);
      if (set) for (const id of set) out.add(id);
    };
    add(`phase:${f.phase}`);
    if (f.tool) add(`tool:${f.tool}`);
    for (const e of f.executables) add(`exe:${e}`);
    for (const o of f.operations) add(`op:${o}`);
    for (const d of f.domains) add(`domain:${d}`);
    for (const l of f.languages) add(`lang:${l}`);
    for (const p of f.packages) add(`pkg:${p}`);
    for (const a of f.artifacts) add(`artifact:${a}`);
    for (const c of f.tokenCues) add(`tok:${c}`);
    if (f.files.length > 0) for (const id of this.fileGlobMemories) out.add(id);
    return out;
  }

  /** Memory ids whose spec declares the given canonical domain (decay path). */
  byDomain(domain: string): Set<string> {
    return this.postings.get(`domain:${canonicalDomain(domain)}`) ?? new Set<string>();
  }

  get size(): number {
    return this.memoryCount;
  }

  get keyCount(): number {
    return this.postings.size;
  }
}
