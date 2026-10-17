import type { ActivatedMemory } from "../../src/core/overseer/overseer.ts";

/**
 * MANUAL GOLD activation specs (§7).
 *
 * Hand-authored activation specs for a representative memory set. These answer the
 * question "if activation compilation were perfect, how good can event-driven
 * retrieval be?" BEFORE we test automatic compilation. The natural-language `rule`
 * is authoritative; `spec` is only the runtime trigger. This same array is written
 * out as the runtime sidecar (`overseer-specs.json`) by the benchmark CLI.
 *
 * Each memory uses only the closed vocabulary in `src/core/overseer/vocab.ts`; an
 * invariant test asserts that.
 */
export const GOLD_MEMORIES: ActivatedMemory[] = [
  // ---- dependencies / package manager -----------------------------------
  {
    id: "bun-not-npm",
    rule: "Always use Bun instead of npm.",
    domain: "package-manager",
    spec: {
      // Relevance keys on dependency-mutating actions + the manifest/lockfile, NOT on
      // `bun run <script>` (running a script is not a package-manager decision).
      domains: ["package-manager"],
      operations: ["package_install", "package_remove"],
      files: ["package.json", "**/package.json"],
      artifacts: ["manifest", "lockfile"],
      // A conflict is any use of a competing package manager. `npx`/`bunx` one-off
      // runners are intentionally NOT flagged (they are not dependency management).
      conflicts: [{ executables: ["npm", "yarn", "pnpm"] }],
    },
  },
  {
    id: "pin-exact-deps",
    rule: "Pin exact dependency versions (no ^ or ~ ranges).",
    domain: "dependency-policy",
    spec: {
      operations: ["package_install"],
      files: ["package.json", "**/package.json"],
      artifacts: ["manifest"],
    },
  },
  // ---- testing ----------------------------------------------------------
  {
    id: "vitest-for-tests",
    rule: "Use Vitest for unit tests.",
    domain: "testing",
    spec: {
      domains: ["testing"],
      operations: ["test_run"],
      artifacts: ["test"],
      files: ["**/*.test.ts", "**/*.spec.ts", "**/*.test.js"],
      conflicts: [{ executables: ["jest", "mocha", "ava"] }],
    },
  },
  {
    id: "playwright-e2e",
    rule: "Use Playwright for end-to-end tests.",
    domain: "testing",
    spec: {
      executables: ["playwright"],
      files: ["**/e2e/**", "**/*.e2e.ts"],
      conflicts: [{ executables: ["cypress"] }],
    },
  },
  // ---- database ---------------------------------------------------------
  {
    id: "postgres-prod",
    rule: "Prefer Postgres in production.",
    domain: "database",
    spec: {
      domains: ["database"],
      executables: ["psql", "prisma"],
      conflicts: [{ executables: ["mysql", "mongo", "mongosh"] }],
    },
  },
  {
    id: "drizzle-orm",
    rule: "Use Drizzle ORM for database access.",
    domain: "database",
    spec: {
      executables: ["drizzle-kit"],
      packages: ["drizzle-orm"],
      conflicts: [{ packages: ["prisma", "typeorm", "sequelize", "knex", "mikro-orm"] }],
    },
  },
  {
    id: "reversible-migrations",
    rule: "Every database migration must be reversible (provide a down step).",
    domain: "database",
    spec: {
      artifacts: ["migration"],
      operations: ["migration_edit"],
    },
  },
  // ---- migration workflow (TEMPORAL) ------------------------------------
  {
    id: "test-after-migration",
    rule: "Run tests after changing database migrations.",
    domain: "database",
    spec: {
      artifacts: ["migration"],
      operations: ["migration_edit", "migration_run"],
    },
    temporal: { triggerOps: ["migration_edit", "migration_run"], satisfyOps: ["test_run"] },
  },
  // ---- auth / security --------------------------------------------------
  {
    id: "auth-server-side",
    rule: "Keep authentication and session logic server-side.",
    domain: "security",
    spec: {
      // Keyed on concrete auth/session files rather than the broad `security` domain,
      // so editing an unrelated .env or security-adjacent file does not surface it.
      files: ["**/auth/**", "**/*auth*.ts", "**/session*.ts"],
      conflicts: [{ files: ["**/components/**/*auth*", "**/client/**/*auth*", "**/public/**/*auth*"] }],
    },
  },
  {
    id: "no-secrets-in-logs",
    rule: "Never print secrets, tokens, or credentials to logs.",
    domain: "security",
    spec: {
      artifacts: ["logger"],
      operations: ["log_write"],
      conflicts: [
        {
          operations: ["log_write"],
          tokens: [
            "secret",
            "password",
            "apikey",
            "api_key",
            "accesstoken",
            "access_token",
            "refreshtoken",
            "refresh_token",
            "privatekey",
            "private_key",
            "credential",
            "authtoken",
            "auth_token",
            "bearer",
            "sessiontoken",
            "session_token",
            "client_secret",
          ],
        },
      ],
    },
  },
  {
    id: "secrets-in-env",
    rule: "Store secrets in environment variables, never hard-code or commit them.",
    domain: "security",
    spec: {
      artifacts: ["env_file"],
      files: ["**/.env", "**/.env.*"],
    },
  },
  // ---- deployment -------------------------------------------------------
  {
    id: "deploy-fly",
    rule: "Deploy to Fly.io.",
    domain: "infrastructure",
    spec: {
      // Keyed on the deploy ACTION/tools, not the broad `infrastructure` domain, so a
      // CI-config or cache edit does not surface the deploy target.
      executables: ["fly", "flyctl"],
      operations: ["deploy"],
      conflicts: [{ executables: ["vercel", "netlify", "wrangler"] }],
    },
  },
  {
    id: "ci-github-actions",
    rule: "CI runs on GitHub Actions; keep workflows under .github/workflows.",
    domain: "infrastructure",
    spec: {
      artifacts: ["ci"],
      files: ["**/.github/workflows/**"],
    },
  },
  // ---- jobs / queues ----------------------------------------------------
  {
    id: "bullmq-jobs",
    rule: "Use BullMQ for background jobs.",
    domain: "infrastructure",
    spec: {
      packages: ["bullmq"],
      files: ["**/jobs/**", "**/queues/**", "**/workers/**", "**/*worker*.ts"],
      conflicts: [{ packages: ["bull", "agenda", "bee-queue", "kue", "bree"] }],
    },
  },
  // ---- formatting / style ----------------------------------------------
  {
    id: "prettier-format",
    rule: "Format code with Prettier.",
    domain: "formatting",
    spec: {
      // Keyed on the concrete format action/tool, NOT the broad `formatting` domain,
      // so running ESLint does not also surface the formatter (precision).
      operations: ["format"],
      executables: ["prettier"],
    },
  },
  {
    id: "eslint-lint",
    rule: "Lint with ESLint before committing.",
    domain: "formatting",
    spec: {
      operations: ["lint"],
      executables: ["eslint"],
    },
  },
  // ---- generated files --------------------------------------------------
  {
    id: "no-edit-generated",
    rule: "Don't edit generated files by hand.",
    domain: "architecture",
    spec: {
      artifacts: ["generated"],
      conflicts: [{ operations: ["file_edit"], artifacts: ["generated"] }],
    },
  },
  {
    id: "no-edit-lockfile",
    rule: "Don't hand-edit lockfiles; change them only via the package manager.",
    domain: "package-manager",
    spec: {
      artifacts: ["lockfile"],
      conflicts: [{ operations: ["file_edit"], artifacts: ["lockfile"] }],
    },
  },
  // ---- validation / architecture ---------------------------------------
  {
    id: "zod-validation",
    rule: "Validate all external input with Zod.",
    domain: "architecture",
    spec: {
      packages: ["zod"],
      conflicts: [{ packages: ["joi", "yup", "ajv", "superstruct", "class-validator"] }],
    },
  },
  {
    id: "react-ui",
    rule: "Build UI with React.",
    domain: "frontend",
    spec: {
      domains: ["frontend"],
      packages: ["react", "react-dom"],
      conflicts: [{ packages: ["vue", "svelte", "@angular/core", "solid-js", "preact"] }],
    },
  },
  {
    id: "tailwind-styles",
    rule: "Style with Tailwind CSS.",
    domain: "frontend",
    spec: {
      packages: ["tailwindcss"],
      files: ["**/tailwind.config.*"],
      conflicts: [{ packages: ["styled-components", "@emotion/react", "sass", "bootstrap"] }],
    },
  },
  {
    id: "pino-logger",
    rule: "Use Pino for structured logging.",
    domain: "architecture",
    spec: {
      artifacts: ["logger"],
      packages: ["pino"],
      conflicts: [{ packages: ["winston", "bunyan", "morgan", "log4js"] }],
    },
  },
  {
    id: "redis-cache",
    rule: "Use Redis for caching.",
    domain: "infrastructure",
    spec: {
      packages: ["redis", "ioredis"],
      executables: ["redis-cli"],
      conflicts: [{ packages: ["memcached", "node-cache"] }],
    },
  },
];

/** The gold memory ids, for scenario authoring + score keys. */
export const GOLD_IDS = GOLD_MEMORIES.map((m) => m.id);
