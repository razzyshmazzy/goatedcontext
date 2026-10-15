/**
 * Detail cards for the right pane: a preference, a signal, an agent, or the Vector
 * Memory placeholder. Detail views expose only fields the schema actually supports
 * (spec §9/§10/§16) — nothing is invented. Signals are framed explicitly as evidence,
 * never as authoritative defaults (spec §10).
 */
import type { AgentVM, PreferenceVM, SectionVM, SignalVM } from "../types.ts";
import { type StyledLine, blank, sl, width } from "../layout.ts";

const ACCENT = 36;

function wrap(text: string, w: number): string[] {
  if (w <= 0) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (width(line) + 1 + width(word) <= w) line += " " + word;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line.length > 0) out.push(line);
  return out.length > 0 ? out : [""];
}

function field(lines: StyledLine[], label: string, value: string, w: number): void {
  lines.push(sl(`   ${label.padEnd(13)} ${value}`, w, {}));
}

function padTo(lines: StyledLine[], w: number, height: number): StyledLine[] {
  while (lines.length < height) lines.push(blank(w));
  return lines.slice(0, height);
}

export function renderPlaceholder(section: SectionVM, w: number, height: number): StyledLine[] {
  const lines: StyledLine[] = [blank(w)];
  section.placeholder.forEach((l, i) => {
    lines.push(sl("  " + l, w, i === 0 ? { bold: true } : { dim: true }));
  });
  return padTo(lines, w, height);
}

export function renderPreferenceDetail(p: PreferenceVM, w: number, height: number): StyledLine[] {
  const lines: StyledLine[] = [];
  lines.push(sl(" Preference", w, { bold: true, fg: ACCENT }));
  lines.push(blank(w));
  for (const l of wrap(p.rule, w - 4)) lines.push(sl("   " + l, w, {}));
  lines.push(blank(w));
  field(lines, "scope", p.scope + (p.repoName ? ` (${p.repoName})` : ""), w);
  field(lines, "status", p.status, w);
  field(lines, "applicability", p.applicability, w);
  field(lines, "domain", p.domain ?? "-", w);
  field(lines, "polarity", p.polarity, w);
  field(lines, "category", p.category, w);
  field(lines, "confidence", p.confidence.toFixed(2), w);
  if (p.condition) field(lines, "condition", p.condition, w);
  field(lines, "created", p.createdAt.replace("T", " ").replace(/\..*$/, ""), w);
  field(lines, "last used", p.lastUsedAt ? p.lastUsedAt.replace("T", " ").replace(/\..*$/, "") : "never", w);
  lines.push(blank(w));
  lines.push(sl(`   evidence (${p.evidence.length})`, w, { dim: true }));
  for (const e of p.evidence.slice(0, 6)) {
    const who = e.agentId ? `${e.source}/${e.agentId}` : e.source;
    for (const l of wrap(`(${who}) ${e.text}`, w - 6)) lines.push(sl("     " + l, w, { dim: true }));
  }
  return padTo(lines, w, height);
}

export function renderSignalDetail(s: SignalVM, w: number, height: number): StyledLine[] {
  const lines: StyledLine[] = [];
  lines.push(sl(" Signal", w, { bold: true, fg: ACCENT }));
  lines.push(sl(" evidence — a past decision, not an authoritative default", w, { dim: true }));
  lines.push(blank(w));
  field(lines, "domain", s.domain, w);
  field(lines, "choice", s.choice, w);
  field(lines, "repo", s.repoName ?? "(cross-repo)", w);
  field(lines, "source", s.source, w);
  field(lines, "exception", s.isException ? "yes" : "no", w);
  if (s.preferredChoice) field(lines, "vs preferred", s.preferredChoice, w);
  if (s.constraint) field(lines, "constraint", s.constraint, w);
  field(lines, "recorded", s.createdAt.replace("T", " ").replace(/\..*$/, ""), w);
  if (s.reason) {
    lines.push(blank(w));
    lines.push(sl("   reason", w, { dim: true }));
    for (const l of wrap(s.reason, w - 6)) lines.push(sl("     " + l, w, {}));
  }
  if (s.context) {
    lines.push(blank(w));
    lines.push(sl("   context", w, { dim: true }));
    for (const l of wrap(s.context, w - 6)) lines.push(sl("     " + l, w, { dim: true }));
  }
  return padTo(lines, w, height);
}

export function renderAgentDetail(a: AgentVM, w: number, height: number): StyledLine[] {
  const lines: StyledLine[] = [];
  lines.push(sl(` ${a.label}`, w, { bold: true, fg: ACCENT }));
  lines.push(sl(` ${a.mark}  ${a.statusLabel}`, w, {}));
  lines.push(blank(w));
  field(lines, "detected", a.detected ? "yes" : "no", w);
  field(lines, "installed", a.installed ? "yes" : "no", w);
  field(lines, "healthy", a.healthy ? "yes" : "no", w);
  field(lines, "interfaces", a.capabilities.length ? a.capabilities.join(", ") : "-", w);
  lines.push(blank(w));
  lines.push(sl("   config", w, { dim: true }));
  for (const l of wrap(a.configPath, w - 6)) lines.push(sl("     " + l, w, { dim: true }));
  if (a.notes.length > 0) {
    lines.push(blank(w));
    lines.push(sl("   notes", w, { dim: true }));
    for (const n of a.notes) for (const l of wrap(n, w - 6)) lines.push(sl("     - " + l, w, { dim: true }));
  }
  return padTo(lines, w, height);
}
