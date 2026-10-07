import type { Database } from "../../storage/sqlite/driver.ts";
import { z } from "zod";
import { newId } from "../../utils/id.ts";
import { nowIso } from "../../utils/time.ts";
import { CtxError, NotFoundError } from "../../utils/errors.ts";
import { envVarSecretRef, assertUsableEnvValue, type SecretStore } from "../../storage/secrets/index.ts";
import { recordEvent } from "../events/service.ts";
import { withFileLock } from "../../utils/fs.ts";

export const EnvScope = z.enum(["global", "repo"]);
export type EnvScope = z.infer<typeof EnvScope>;

/**
 * Risk level of an environment. `prod` is modelled now so that access policies
 * (explicit confirmation before use) can be layered on later without a schema
 * change; the MVP treats it as advisory metadata.
 */
export const RiskLevel = z.enum(["test", "dev", "prod"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export interface Environment {
  id: string;
  name: string;
  scope: EnvScope;
  repoId: string | null;
  riskLevel: RiskLevel;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EnvRow {
  id: string;
  name: string;
  scope: string;
  repo_id: string | null;
  risk_level: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface EnvVarRow {
  id: string;
  environment_id: string;
  var_name: string;
  secret_ref: string;
  created_at: string;
}

function rowToEnv(r: EnvRow): Environment {
  return {
    id: r.id,
    name: r.name,
    scope: r.scope as EnvScope,
    repoId: r.repo_id,
    riskLevel: r.risk_level as RiskLevel,
    description: r.description,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface AddEnvironmentInput {
  name: string;
  scope?: EnvScope;
  repoId?: string | null;
  riskLevel?: RiskLevel;
  description?: string | null;
}

export interface EnvironmentAvailability {
  environment: Environment;
  variableNames: string[];
  /** True when every declared variable has a stored secret value. */
  available: boolean;
}

export class EnvironmentService {
  constructor(
    private readonly db: Database,
    private readonly secrets: SecretStore,
    /**
     * Cross-process lock file guarding the combined declaration+value mutation. A
     * variable's declaration (SQLite) and its value (secret store) cannot share one
     * transaction, so concurrent `env set` calls are serialized here to keep the pair
     * atomic. Omitted only in legacy direct constructions (tests); such callers lose
     * cross-process serialization but keep single-process correctness.
     */
    private readonly varWriteLock?: string,
  ) {}

  add(input: AddEnvironmentInput): Environment {
    const name = (input.name ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new CtxError(
        `Invalid environment name "${input.name}". Use letters, digits, and . _ - (must start alphanumeric).`,
      );
    }
    const scope = EnvScope.parse(input.scope ?? "global");
    RiskLevel.parse(input.riskLevel ?? "test");
    const repoId = input.repoId ?? null;
    if (scope === "repo" && !repoId) {
      throw new CtxError(
        "Repo-scoped environments require a repository. Run inside a git repo or use --scope global.",
      );
    }
    if (scope === "global" && repoId) {
      throw new CtxError("Global environments must not be bound to a repo.");
    }
    if (this.findByName(name, repoId)) {
      throw new CtxError(`An environment named "${name}" already exists in this scope.`);
    }
    const id = newId();
    const ts = nowIso();
    this.db
      .query(
        `INSERT INTO environments (id, name, scope, repo_id, risk_level, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        scope,
        repoId,
        input.riskLevel ?? "test",
        input.description ?? null,
        ts,
        ts,
      );
    recordEvent(this.db, {
      type: "environment.created",
      repoId,
      scope,
      summary: name,
      detail: { riskLevel: input.riskLevel ?? "test" },
    });
    return this.getById(id)!;
  }

  getById(id: string): Environment | null {
    const row = this.db
      .query<EnvRow, [string]>("SELECT * FROM environments WHERE id = ?")
      .get(id);
    return row ? rowToEnv(row) : null;
  }

  /** Find an environment by name visible to the given repo (repo-scoped first, then global). */
  findByName(name: string, repoId: string | null): Environment | null {
    if (repoId) {
      const repoScoped = this.db
        .query<EnvRow, [string, string]>(
          "SELECT * FROM environments WHERE name = ? AND repo_id = ?",
        )
        .get(name, repoId);
      if (repoScoped) return rowToEnv(repoScoped);
    }
    const global = this.db
      .query<EnvRow, [string]>(
        "SELECT * FROM environments WHERE name = ? AND scope = 'global'",
      )
      .get(name);
    return global ? rowToEnv(global) : null;
  }

  requireByName(name: string, repoId: string | null): Environment {
    const env = this.findByName(name, repoId);
    if (!env) throw new NotFoundError(`No environment named "${name}".`);
    return env;
  }

  list(): Environment[] {
    return this.db
      .query<EnvRow, []>("SELECT * FROM environments ORDER BY name ASC")
      .all()
      .map(rowToEnv);
  }

  /** Environments applicable to a repo: all global ones plus that repo's own. */
  listApplicable(repoId: string | null): EnvironmentAvailability[] {
    return this.list()
      .filter((e) => e.scope === "global" || (repoId != null && e.repoId === repoId))
      .map((e) => this.availability(e));
  }

  availability(env: Environment): EnvironmentAvailability {
    const vars = this.variables(env.id);
    // "available" must mean the value can actually be injected into `env run` — not
    // merely that a stored row exists. A missing key, a corrupt store, or a value that
    // no longer decrypts all make the secret UNavailable, so we probe real readability
    // (never exposing the value) rather than trusting `has`, which would report a
    // deleted-key environment as healthy and mislead the user.
    const available =
      vars.length > 0 &&
      vars.every((v) => {
        try {
          return this.secrets.get(v.secret_ref) != null;
        } catch {
          return false; // missing key / corrupt store / decryption failure
        }
      });
    return {
      environment: env,
      variableNames: vars.map((v) => v.var_name),
      available,
    };
  }

  private variables(environmentId: string): EnvVarRow[] {
    return this.db
      .query<EnvVarRow, [string]>(
        "SELECT * FROM environment_variables WHERE environment_id = ? ORDER BY var_name ASC",
      )
      .all(environmentId);
  }

  variableNames(environmentId: string): string[] {
    return this.variables(environmentId).map((v) => v.var_name);
  }

  /**
   * Declare/overwrite a variable and store its secret VALUE in the secret store.
   * Only the variable name and an opaque secret_ref are written to SQLite.
   */
  setVariable(environmentId: string, varName: string, value: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
      throw new CtxError(`Invalid environment variable name: "${varName}".`);
    }
    // Reject values the runtime cannot accept as an env var (e.g. a NUL byte) at the
    // earliest boundary — before any store or DB write — so a value that would later
    // make `spawn` throw (and echo the plaintext) can never be persisted.
    assertUsableEnvValue(value, varName);
    const ref = envVarSecretRef(environmentId, varName);

    // The declaration (SQLite row) and the value (secret store) live in two stores and
    // cannot share one transaction. Serialize the COMBINED mutation across processes so
    // two concurrent `ctx env set` calls on the SAME new variable can never interleave
    // into a half-written state (the old race left "declaration present, value deleted"
    // when a losing writer's UNIQUE-violation compensation deleted the winner's secret).
    this.withVarLock(() => {
      const existing = this.db
        .query<EnvVarRow, [string, string]>(
          "SELECT * FROM environment_variables WHERE environment_id = ? AND var_name = ?",
        )
        .get(environmentId, varName);

      if (existing) {
        // Declaration already present → update the value in place. Last writer wins;
        // the declaration is untouched, so no partial state is possible.
        this.secrets.set(ref, value);
        return;
      }

      // New variable: write the VALUE first, then the declaration. If the declaration
      // INSERT fails, roll the value back — leaving neither (the prior valid state). The
      // value-first order means the only possible crash remnant is an orphan secret with
      // no declaration, which is invisible to env list/vars/run (never a broken, declared
      // variable with a missing value). Under the lock the rollback cannot race another
      // writer, so deleting `ref` is safe.
      this.secrets.set(ref, value);
      try {
        this.db
          .query(
            `INSERT INTO environment_variables (id, environment_id, var_name, secret_ref, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(newId(), environmentId, varName, ref, nowIso());
      } catch (err) {
        try {
          this.secrets.delete(ref);
        } catch {
          /* best-effort rollback — surface the original INSERT error below */
        }
        throw err;
      }
    });
  }

  /** Run `fn` under the cross-process variable-write lock, or directly if none was wired. */
  private withVarLock<T>(fn: () => T): T {
    return this.varWriteLock ? withFileLock(this.varWriteLock, fn) : fn();
  }

  removeVariable(environmentId: string, varName: string): void {
    const ref = envVarSecretRef(environmentId, varName);
    // Same cross-process lock as setVariable, so a concurrent set+remove on the same
    // variable can never interleave into a split declaration/value state. Delete the
    // DECLARATION first (the variable disappears atomically from list/vars/run), then
    // the value — a crash between leaves only an invisible orphan secret.
    this.withVarLock(() => {
      this.db
        .query(
          "DELETE FROM environment_variables WHERE environment_id = ? AND var_name = ?",
        )
        .run(environmentId, varName);
      this.secrets.delete(ref);
    });
  }

  /**
   * Resolve the merged variable name→value map for one or more environments.
   * Later environments win on name conflicts, enabling composition such as
   * `ctx env run supabase-test openai-dev -- npm test`.
   *
   * The returned values are secrets — callers must inject them only into a child
   * process environment and never print them.
   */
  resolveVariables(envs: Environment[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const env of envs) {
      for (const v of this.variables(env.id)) {
        const value = this.secrets.get(v.secret_ref);
        if (value == null) {
          throw new CtxError(
            `Environment "${env.name}" declares "${v.var_name}" but its value is missing. ` +
              `Set it with: ctx env set ${env.name} ${v.var_name}`,
          );
        }
        // Defense in depth: a value persisted by an older ctx (before set-time
        // validation) could still carry a NUL byte. Reject it HERE, before it reaches
        // the child env, so the runtime never throws an error that echoes the plaintext.
        assertUsableEnvValue(value, v.var_name);
        out[v.var_name] = value;
      }
    }
    return out;
  }

  remove(env: Environment): void {
    // Under the same lock as set/removeVariable (one consistent ordering, no nesting).
    // Delete the environment row FIRST — the ON DELETE CASCADE removes every variable
    // declaration atomically — then delete the secret values. A crash between leaves
    // only invisible orphan secrets, never a declared variable with a missing value.
    this.withVarLock(() => {
      const refs = this.variables(env.id).map((v) => v.secret_ref);
      this.db.query("DELETE FROM environments WHERE id = ?").run(env.id);
      for (const ref of refs) this.secrets.delete(ref);
      recordEvent(this.db, {
        type: "environment.removed",
        repoId: env.repoId,
        scope: env.scope,
        summary: env.name,
      });
    });
  }
}
