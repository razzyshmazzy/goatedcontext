import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { newId } from "../../utils/id.ts";
import { nowIso } from "../../utils/time.ts";
import { gitOriginUrl, gitToplevel } from "../../utils/git.ts";

export interface Repo {
  id: string;
  identity: string;
  name: string;
  remoteUrl: string | null;
  rootPath: string;
  hasRemote: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RepoRow {
  id: string;
  identity: string;
  name: string;
  remote_url: string | null;
  root_path: string;
  has_remote: number;
  created_at: string;
  updated_at: string;
}

function rowToRepo(r: RepoRow): Repo {
  return {
    id: r.id,
    identity: r.identity,
    name: r.name,
    remoteUrl: r.remote_url,
    rootPath: r.root_path,
    hasRemote: r.has_remote === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Reduce a git remote URL to a canonical, host-relative identity so the same
 * repository maps to the same id regardless of transport (ssh/https) or
 * embedded credentials.
 *
 *   git@github.com:acme/app.git        -> github.com/acme/app
 *   https://u:p@github.com/acme/app.git -> github.com/acme/app
 */
export function canonicalizeRemote(url: string): string | null {
  let u = url.trim();
  if (!u) return null;
  u = u.replace(/\.git$/, "");
  // scp-like syntax: git@host:path
  const scp = u.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  if (scp) return `${scp[1]}/${scp[2]}`.replace(/\/+/g, "/");
  // strip scheme and credentials
  u = u.replace(/^[a-z]+:\/\//i, "");
  u = u.replace(/^[^@/]+@/, "");
  return u.replace(/\/+/g, "/") || null;
}

/**
 * Determine a stable identity for the repo rooted at `cwd`.
 *
 * Prefers the canonical origin remote so the identity survives the repo being
 * moved or re-cloned. Repos without a remote fall back to a hash of the root
 * path — stable in place, but treated as a new repo if the directory moves (a
 * documented MVP limitation).
 */
export function detectRepoIdentity(cwd: string): {
  root: string;
  identity: string;
  name: string;
  remoteUrl: string | null;
  hasRemote: boolean;
} | null {
  const root = gitToplevel(cwd);
  if (!root) return null;

  const remoteUrl = gitOriginUrl(cwd);
  const canonical = remoteUrl ? canonicalizeRemote(remoteUrl) : null;

  if (canonical) {
    return {
      root,
      identity: `remote:${canonical}`,
      name: basename(canonical),
      remoteUrl,
      hasRemote: true,
    };
  }

  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return {
    root,
    identity: `path:${hash}`,
    name: basename(root),
    remoteUrl: null,
    hasRemote: false,
  };
}

export class RepoService {
  constructor(private readonly db: Database) {}

  getByIdentity(identity: string): Repo | null {
    const row = this.db
      .query<RepoRow, [string]>("SELECT * FROM repos WHERE identity = ?")
      .get(identity);
    return row ? rowToRepo(row) : null;
  }

  getById(id: string): Repo | null {
    const row = this.db
      .query<RepoRow, [string]>("SELECT * FROM repos WHERE id = ?")
      .get(id);
    return row ? rowToRepo(row) : null;
  }

  /** All known repositories, newest first. */
  list(): Repo[] {
    return this.db
      .query<RepoRow, []>("SELECT * FROM repos ORDER BY created_at DESC, id ASC")
      .all()
      .map(rowToRepo);
  }

  /**
   * Get an existing repo by its stable identity, or create one from portable
   * metadata (used by `ctx import`). Unlike `resolve`, this does not touch git —
   * the identity is authoritative. `rootPath` may be a foreign path; it is only
   * advisory and is refreshed by `resolve` next time the repo is opened locally.
   */
  ensureByIdentity(input: {
    identity: string;
    name: string;
    remoteUrl: string | null;
    hasRemote: boolean;
    rootPath: string;
  }): Repo {
    const existing = this.getByIdentity(input.identity);
    if (existing) return existing;
    const id = newId();
    const ts = nowIso();
    this.db
      .query(
        `INSERT INTO repos (id, identity, name, remote_url, root_path, has_remote, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.identity,
        input.name,
        input.remoteUrl,
        input.rootPath,
        input.hasRemote ? 1 : 0,
        ts,
        ts,
      );
    return this.getById(id)!;
  }

  /** Resolve the repo for `cwd`, registering it on first sight. Null if not a git repo. */
  resolve(cwd: string): Repo | null {
    const detected = detectRepoIdentity(cwd);
    if (!detected) return null;

    const existing = this.getByIdentity(detected.identity);
    const ts = nowIso();
    if (existing) {
      // Keep name/root/remote fresh if the repo moved or gained a remote.
      if (
        existing.rootPath !== detected.root ||
        existing.remoteUrl !== detected.remoteUrl ||
        existing.name !== detected.name
      ) {
        this.db
          .query(
            "UPDATE repos SET root_path = ?, remote_url = ?, name = ?, has_remote = ?, updated_at = ? WHERE id = ?",
          )
          .run(
            detected.root,
            detected.remoteUrl,
            detected.name,
            detected.hasRemote ? 1 : 0,
            ts,
            existing.id,
          );
        return this.getById(existing.id)!;
      }
      return existing;
    }

    const id = newId();
    this.db
      .query(
        `INSERT INTO repos (id, identity, name, remote_url, root_path, has_remote, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        detected.identity,
        detected.name,
        detected.remoteUrl,
        detected.root,
        detected.hasRemote ? 1 : 0,
        ts,
        ts,
      );
    return this.getById(id)!;
  }
}
