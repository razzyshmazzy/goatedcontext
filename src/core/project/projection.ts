import type { CtxContext } from "../context.ts";
import type { Preference } from "../preferences/types.ts";
import { resolveConflicts } from "../retrieval/retrieval.ts";
import { precedenceRank } from "../retrieval/precedence.ts";
import { sanitizeInjectedText } from "../render/context-block.ts";
import { planDelivery } from "../agents/delivery.ts";
import { AGENTS_FILE_CAPABILITIES } from "../agents/capabilities.ts";

/**
 * The STATIC interoperability projection (0.2.9, corrected policy).
 *
 * `AGENTS.md` is a static REPO projection, so it materializes ONLY preferences that
 * are safe to pin unconditionally into a repository the whole team shares:
 *
 *     scope = repo   AND   status ∈ {approved, locked}   AND   applicability = always
 *
 * and NOTHING else. In particular it NEVER materializes global preferences (a
 * personal always-rule must not silently land in a repo), `relevant` preferences
 * (which must not become unconditional merely by being written to a file),
 * `conditional` preferences (runtime-only), or proposed/rejected/evidence/secrets.
 *
 * The selection is not hand-rolled: it is the `static` bucket of the shared
 * delivery planner evaluated with the capability profile of a plain AGENTS.md file,
 * so this materializer can never diverge from the runtime routing policy. Candidates
 * are first scoped to THIS repo (global + this repo's rows) so one repo's AGENTS.md
 * can never contain another repo's rules.
 */

export interface ProjectionRule {
  id: string;
  rule: string;
  scope: "global" | "repo";
  domain: string | null;
}

export interface Projection {
  repo: { id: string; name: string; identity: string } | null;
  rules: ProjectionRule[];
}

/**
 * The preferences statically materialized for the repo at `cwd`: repo-scoped,
 * approved/locked, always — conflict-resolved and deterministically ordered.
 * Returns the full `Preference` rows (callers that need IDs, e.g. runtime dedup,
 * use `.id`). Registers the repo on first sight (callers do explicit sync/install).
 */
export function selectStaticPreferences(ctx: CtxContext, cwd: string): {
  repo: { id: string; name: string; identity: string } | null;
  preferences: Preference[];
} {
  const repo = ctx.repos.resolve(cwd);
  if (!repo) return { repo: null, preferences: [] };

  // Scope candidates to THIS repo (+ global) FIRST — repo isolation. A repo-scoped
  // row for a different repo can never be considered here. Filtered in SQL (D2) so a
  // many-repo store does not materialize unrelated repos' rows; semantics are
  // identical to the prior `list().filter(global || this-repo)` over active rows
  // (the subsequent planDelivery static bucket already requires approved/locked).
  const candidates = ctx.preferences.listCandidates({ repoId: repo.id });

  // The static bucket for a plain AGENTS.md file == repo approved/locked always.
  const staticIds = new Set(planDelivery(AGENTS_FILE_CAPABILITIES, candidates).static);
  const selected = candidates.filter((p) => staticIds.has(p.id));

  // Resolve exclusive-domain / same-subject collisions deterministically.
  const { winners } = resolveConflicts(selected);
  const ordered = winners
    .slice()
    .sort(
      (a, b) =>
        precedenceRank(a) - precedenceRank(b) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );

  return {
    repo: { id: repo.id, name: repo.name, identity: repo.identity },
    preferences: ordered,
  };
}

/** Compute the static projection (rules view) for the repository at `cwd`. */
export function buildProjection(ctx: CtxContext, cwd: string): Projection {
  const { repo, preferences } = selectStaticPreferences(ctx, cwd);
  return {
    repo,
    rules: preferences.map((p) => ({ id: p.id, rule: p.rule, scope: p.scope, domain: p.domain })),
  };
}

const PREAMBLE = [
  "These are the developer's persistent engineering preferences for THIS repository,",
  "maintained by goatedcontext (`ctx`). Treat them as guidance to honor. This block is",
  "generated from repo-scoped always-on rules; edit them with `ctx`, not by hand.",
].join("\n");

/** The managed-block markers used inside a shared `AGENTS.md`. */
export const AGENTS_BEGIN = "<!-- goatedcontext:begin -->";
export const AGENTS_END = "<!-- goatedcontext:end -->";

function renderRuleLines(rules: ProjectionRule[]): string[] {
  if (rules.length === 0) return ["- (no repo always-on preferences recorded yet)"];
  return rules.map((r) => {
    const domain = r.domain ? `/${sanitizeInjectedText(r.domain)}` : "";
    return `- [${r.scope}${domain}] ${sanitizeInjectedText(r.rule)}`;
  });
}

/** The full managed block (with markers) to upsert into a shared `AGENTS.md`. */
export function renderAgentsBlock(projection: Projection): string {
  const repoLine = projection.repo
    ? `Repository: ${sanitizeInjectedText(projection.repo.name)}`
    : "Repository: (unknown)";
  return [
    AGENTS_BEGIN,
    "## Developer Context (goatedcontext)",
    "",
    PREAMBLE,
    "",
    repoLine,
    "",
    "Preferences:",
    ...renderRuleLines(projection.rules),
    AGENTS_END,
  ].join("\n");
}
