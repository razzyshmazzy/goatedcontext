import type { Database } from "bun:sqlite";
import { z } from "zod";
import { newId } from "../../utils/id.ts";
import { nowIso } from "../../utils/time.ts";
import { CtxError, NotFoundError } from "../../utils/errors.ts";
import { envVarSecretRef, type SecretStore } from "../../storage/secrets/index.ts";
import { recordEvent } from "../events/service.ts";

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
    const available =
      vars.length > 0 && vars.every((v) => this.secrets.has(v.secret_ref));
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
    const ref = envVarSecretRef(environmentId, varName);
    this.secrets.set(ref, value);

    const existing = this.db
      .query<EnvVarRow, [string, string]>(
        "SELECT * FROM environment_variables WHERE environment_id = ? AND var_name = ?",
      )
      .get(environmentId, varName);
    if (existing) return; // secret updated in place; metadata unchanged

    this.db
      .query(
        `INSERT INTO environment_variables (id, environment_id, var_name, secret_ref, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(newId(), environmentId, varName, ref, nowIso());
  }

  removeVariable(environmentId: string, varName: string): void {
    const ref = envVarSecretRef(environmentId, varName);
    this.secrets.delete(ref);
    this.db
      .query(
        "DELETE FROM environment_variables WHERE environment_id = ? AND var_name = ?",
      )
      .run(environmentId, varName);
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
        out[v.var_name] = value;
      }
    }
    return out;
  }

  remove(env: Environment): void {
    for (const v of this.variables(env.id)) {
      this.secrets.delete(v.secret_ref);
    }
    this.db.query("DELETE FROM environments WHERE id = ?").run(env.id);
    recordEvent(this.db, {
      type: "environment.removed",
      repoId: env.repoId,
      scope: env.scope,
      summary: env.name,
    });
  }
}
