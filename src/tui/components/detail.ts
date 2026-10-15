/**
 * Detail content for the right pane / modal: a preference, a signal, an agent, or the
 * Vector Memory placeholder. Labels are padded to a common gutter and values are
 * aligned (the single highest-impact readability technique). Only real schema fields
 * are shown (spec §9/§10/§16); signals are explicitly framed as evidence (spec §10).
 */
import type { AgentVM, PreferenceVM, SectionVM, SignalVM } from "../types.ts";
import { type PanelLine, type Role, type Style, span, width } from "../layout.ts";

const GUTTER = 15;

function wrap(text: string, w: number): string[] {
  if (w <= 4) return [text];
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
  return out.length ? out : [""];
}

function blank(): PanelLine {
  return { spans: [span("")] };
}

function field(label: string, value: string, valueStyle: Style = {}): PanelLine {
  return {
    spans: [
      span("  " + (label + ":").padEnd(GUTTER), { dim: true }),
      span(value, valueStyle),
    ],
  };
}

function subtitle(text: string): PanelLine {
  return { spans: [span(" " + text, { dim: true })] };
}

const STATUS_ROLE: Record<string, Role> = {
  approved: "success",
  locked: "warning",
  proposed: "accent",
  observed: "accent",
  rejected: "danger",
};

export function preferenceDetail(p: PreferenceVM, innerW: number): PanelLine[] {
  const out: PanelLine[] = [blank()];
  for (const l of wrap(p.rule, innerW - 3)) out.push({ spans: [span("  " + l, { bold: true })] });
  out.push(blank());
  out.push(field("scope", p.scope + (p.repoName ? ` (${p.repoName})` : "")));
  out.push(field("status", p.status, { fg: STATUS_ROLE[p.status] ?? "text", bold: true }));
  out.push(field("applicability", p.applicability));
  out.push(field("domain", p.domain ?? "—"));
  out.push(field("polarity", p.polarity));
  out.push(field("confidence", p.confidence.toFixed(2)));
  if (p.condition) out.push(field("condition", p.condition));
  out.push(field("created", p.createdAt.replace("T", " ").replace(/\..*$/, "")));
  out.push(field("last used", p.lastUsedAt ? p.lastUsedAt.replace("T", " ").replace(/\..*$/, "") : "never"));
  out.push(blank());
  out.push({ spans: [span(`  evidence (${p.evidence.length})`, { dim: true })] });
  for (const e of p.evidence.slice(0, 5)) {
    const who = e.agentId ? `${e.source}/${e.agentId}` : e.source;
    const lines = wrap(`${who} · ${e.text}`, innerW - 5);
    lines.forEach((l, i) => out.push({ spans: [span((i === 0 ? "  • " : "    ") + l, { dim: true })] }));
  }
  return out;
}

export function signalDetail(s: SignalVM, innerW: number): PanelLine[] {
  const out: PanelLine[] = [
    subtitle("evidence — a past decision, not an authoritative rule"),
    blank(),
  ];
  out.push(field("domain", s.domain));
  out.push(field("choice", s.choice, { bold: true }));
  out.push(field("repo", s.repoName ?? "(cross-repo)"));
  out.push(field("source", s.source));
  out.push(field("exception", s.isException ? "yes" : "no", s.isException ? { fg: "warning" } : {}));
  if (s.preferredChoice) out.push(field("vs preferred", s.preferredChoice));
  if (s.constraint) out.push(field("constraint", s.constraint));
  out.push(field("recorded", s.createdAt.replace("T", " ").replace(/\..*$/, "")));
  if (s.reason) {
    out.push(blank());
    out.push({ spans: [span("  reason", { dim: true })] });
    for (const l of wrap(s.reason, innerW - 5)) out.push({ spans: [span("    " + l)] });
  }
  return out;
}

export function agentDetail(a: AgentVM, innerW: number): PanelLine[] {
  const markRole: Role = a.healthy ? "success" : a.installed ? "warning" : "muted";
  const out: PanelLine[] = [
    blank(),
    { spans: [span("  " + a.mark + "  ", { fg: markRole }), span(a.statusLabel, { bold: true })] },
    blank(),
  ];
  out.push(field("detected", a.detected ? "yes" : "no"));
  out.push(field("installed", a.installed ? "yes" : "no"));
  out.push(field("healthy", a.healthy ? "yes" : "no", a.healthy ? { fg: "success" } : {}));
  out.push(field("interfaces", a.capabilities.length ? a.capabilities.join(", ") : "—"));
  out.push(blank());
  out.push({ spans: [span("  config", { dim: true })] });
  for (const l of wrap(a.configPath, innerW - 5)) out.push({ spans: [span("    " + l, { dim: true })] });
  if (a.notes.length) {
    out.push(blank());
    out.push({ spans: [span("  notes", { dim: true })] });
    for (const n of a.notes) for (const l of wrap(n, innerW - 5)) out.push({ spans: [span("    • " + l, { dim: true })] });
  }
  return out;
}

export function placeholderDetail(section: SectionVM, innerW: number): PanelLine[] {
  const out: PanelLine[] = [blank()];
  out.push({ spans: [span("  Semantic memory tier", { bold: true })] });
  out.push({ spans: [span("  status: ", { dim: true }), span("planned", { fg: "warning" })] });
  out.push(blank());
  const body = section.placeholder.filter(
    (l) => !l.toLowerCase().includes("vector memory") && !l.toLowerCase().includes("not enabled"),
  );
  const copy = body.length ? body : ["Structured preferences and signals remain", "the authoritative store."];
  out.push({ spans: [span("  Not enabled yet.", { dim: true })] });
  out.push(blank());
  for (const l of copy) out.push({ spans: [span("  " + l, { dim: true })] });
  void innerW;
  return out;
}
