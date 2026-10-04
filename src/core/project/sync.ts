import { join } from "node:path";
import type { CtxContext } from "../context.ts";
import { CtxError } from "../../utils/errors.ts";
import { withFileLock } from "../../utils/fs.ts";
import {
  upsertManagedBlock,
  removeManagedBlock,
  type BlockAction,
  type RemoveBlockAction,
} from "../../utils/managed-block.ts";
import { buildProjection, renderAgentsBlock, AGENTS_BEGIN, AGENTS_END } from "./projection.ts";

/**
 * Write (or remove) the static interoperability projection for the repository at
 * `cwd`: a single managed block in `<root>/AGENTS.md`.
 *
 * AGENTS.md is the ONE canonical static path. Codex, Cursor, and any other
 * AGENTS.md-aware agent read it; Cursor needs no separate `.cursor/rules` file
 * because our projection is always-on (which AGENTS.md already covers — `.cursor/rules`
 * would only add glob/description scoping we don't use). Per-repo, serialized by a
 * lock in the ctx home so the repo is never littered with a lock file.
 */

export interface SyncResult {
  repo: { name: string; identity: string; root: string };
  ruleCount: number;
  agentsFile: string;
  agentsAction: BlockAction;
}

export interface UnsyncResult {
  repo: { name: string; identity: string; root: string };
  agentsFile: string;
  agentsAction: RemoveBlockAction;
}

function requireRepo(ctx: CtxContext, cwd: string): { id: string; name: string; identity: string; rootPath: string } {
  const repo = ctx.repos.resolve(cwd);
  if (!repo) {
    throw new CtxError(
      "Static projection is repo-scoped. Run inside a git repository (AGENTS.md lives at the repo root).",
    );
  }
  return repo;
}

function lockFor(ctx: CtxContext, repoId: string): string {
  return join(ctx.paths.home, `sync-${repoId}.lock`);
}

/** Project the current store into the repo's AGENTS.md managed block. */
export function syncProject(ctx: CtxContext, cwd: string): SyncResult {
  const repo = requireRepo(ctx, cwd);
  return withFileLock(lockFor(ctx, repo.id), () => {
    const projection = buildProjection(ctx, cwd);
    const agentsFile = join(repo.rootPath, "AGENTS.md");
    const agentsAction = upsertManagedBlock(agentsFile, AGENTS_BEGIN, AGENTS_END, renderAgentsBlock(projection));
    return {
      repo: { name: repo.name, identity: repo.identity, root: repo.rootPath },
      ruleCount: projection.rules.length,
      agentsFile,
      agentsAction,
    };
  });
}

/** Remove the goatedcontext managed block from the repo's AGENTS.md, preserving the rest. */
export function unsyncProject(ctx: CtxContext, cwd: string): UnsyncResult {
  const repo = requireRepo(ctx, cwd);
  return withFileLock(lockFor(ctx, repo.id), () => {
    const agentsFile = join(repo.rootPath, "AGENTS.md");
    const agentsAction = removeManagedBlock(agentsFile, AGENTS_BEGIN, AGENTS_END);
    return {
      repo: { name: repo.name, identity: repo.identity, root: repo.rootPath },
      agentsFile,
      agentsAction,
    };
  });
}
