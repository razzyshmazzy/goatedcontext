import type { Phase } from "../../src/core/overseer/vocab.ts";

/**
 * EVENT-TRAJECTORY benchmark scenarios (§18).
 *
 * Each scenario is a stored-memory set (the full gold store), an initial user prompt,
 * an ordered AgentEvent trace, and the EXPECTED first-relevance + conflict points.
 * Categories span dependencies, testing, database, auth, logging/security,
 * deployment, jobs/queues, formatting, generated files, and the migration workflow;
 * negatives are included so false-activation precision is measured.
 *
 * Expectations name only the KEY memories each trace is designed to exercise.
 * `allow` lists benign co-firers (e.g. a dependency-policy reminder that legitimately
 * fires on every install) so precision is scored fairly: a delivery that is neither
 * expected nor allowed is a false activation.
 */
export interface ScenarioEvent {
  phase: Phase;
  tool?: string;
  command?: { executable?: string; argv?: string[] };
  files?: Array<{ path: string }>;
  text?: string;
}

export interface Expectation {
  id: string;
  /** Event index at which this memory should first become a RELEVANT delivery. */
  relevantAt?: number;
  /** Event index at which this memory should become a CONFLICT delivery. */
  conflictAt?: number;
}

export interface Trajectory {
  id: string;
  klass: string;
  prompt: string;
  events: ScenarioEvent[];
  expect: Expectation[];
  /** Memories that MAY fire without precision penalty (benign co-firers). */
  allow?: string[];
  /**
   * The key memory the ORIGINAL PROMPT could not confidently surface, but a later
   * event makes relevant — the Late-Emerging Context Recall target (§21).
   */
  lateEmergingId?: string;
}

const read = (path: string): ScenarioEvent => ({ phase: "file_read", tool: "Read", files: [{ path }] });
const edit = (path: string, text?: string): ScenarioEvent => ({ phase: "file_write", tool: "Edit", files: [{ path }], text });
const write = (path: string, text?: string): ScenarioEvent => ({ phase: "file_write", tool: "Write", files: [{ path }], text });
const cmd = (executable: string, ...argv: string[]): ScenarioEvent => ({ phase: "command", tool: "Bash", command: { executable, argv } });
const stop = (): ScenarioEvent => ({ phase: "stop" });

export const TRAJECTORIES: Trajectory[] = [
  // ============ dependencies / package manager ============
  {
    id: "dep-bun-conflict",
    klass: "dependencies",
    prompt: "Add input validation to the signup API.",
    events: [read("package.json"), edit("src/auth/signup.ts"), cmd("npm", "install", "zod")],
    expect: [
      { id: "bun-not-npm", relevantAt: 0, conflictAt: 2 },
      { id: "auth-server-side", relevantAt: 1 },
      { id: "zod-validation", relevantAt: 2 },
    ],
    allow: ["pin-exact-deps"],
    lateEmergingId: "bun-not-npm",
  },
  {
    id: "dep-bun-ok",
    klass: "dependencies",
    prompt: "Install dayjs for date formatting.",
    events: [cmd("bun", "add", "dayjs")],
    expect: [{ id: "bun-not-npm", relevantAt: 0 }],
    allow: ["pin-exact-deps"],
  },
  {
    id: "dep-pin-versions",
    klass: "dependencies",
    prompt: "Pull in the redis client.",
    events: [cmd("bun", "add", "ioredis")],
    expect: [{ id: "pin-exact-deps", relevantAt: 0 }, { id: "redis-cache", relevantAt: 0 }],
    allow: ["bun-not-npm"],
    lateEmergingId: "redis-cache",
  },
  {
    id: "dep-yarn-conflict",
    klass: "dependencies",
    prompt: "Set up the project dependencies.",
    events: [read("package.json"), cmd("yarn", "install")],
    expect: [{ id: "bun-not-npm", relevantAt: 0, conflictAt: 1 }],
    allow: ["pin-exact-deps"],
    lateEmergingId: "bun-not-npm",
  },

  // ============ testing ============
  {
    id: "test-jest-conflict",
    klass: "testing",
    prompt: "Add a test for the parser.",
    events: [write("src/parser.test.ts"), cmd("npx", "jest")],
    expect: [{ id: "vitest-for-tests", relevantAt: 0, conflictAt: 1 }],
    lateEmergingId: "vitest-for-tests",
  },
  {
    id: "test-vitest-ok",
    klass: "testing",
    prompt: "Run the unit tests.",
    events: [cmd("bun", "run", "test")],
    expect: [{ id: "vitest-for-tests", relevantAt: 0 }],
  },
  {
    id: "test-cypress-conflict",
    klass: "testing",
    prompt: "Add an end-to-end test for checkout.",
    events: [write("e2e/checkout.spec.ts"), cmd("npx", "cypress", "run")],
    expect: [{ id: "playwright-e2e", relevantAt: 0, conflictAt: 1 }, { id: "vitest-for-tests", relevantAt: 0 }],
    lateEmergingId: "playwright-e2e",
  },

  // ============ database ============
  {
    id: "db-mysql-conflict",
    klass: "database",
    prompt: "Fix the connection pooling bug.",
    events: [cmd("mysql", "-u", "root", "app")],
    expect: [{ id: "postgres-prod", conflictAt: 0 }],
    lateEmergingId: "postgres-prod",
  },
  {
    id: "db-orm-conflict",
    klass: "database",
    prompt: "Add a repository layer.",
    events: [cmd("npm", "install", "prisma")],
    expect: [{ id: "drizzle-orm", conflictAt: 0 }, { id: "bun-not-npm", conflictAt: 0 }],
    allow: ["pin-exact-deps"],
    lateEmergingId: "drizzle-orm",
  },

  // ============ migration workflow (temporal) ============
  {
    id: "migration-unresolved",
    klass: "migration",
    prompt: "Update the users table schema.",
    events: [edit("db/migrations/0003_users.sql"), edit("src/models/user.ts"), stop()],
    expect: [
      { id: "test-after-migration", relevantAt: 0, conflictAt: 2 },
      { id: "reversible-migrations", relevantAt: 0 },
    ],
    allow: ["postgres-prod"],
    lateEmergingId: "test-after-migration",
  },
  {
    id: "migration-satisfied",
    klass: "migration",
    prompt: "Update the users table schema and verify.",
    events: [edit("db/migrations/0004_orders.sql"), cmd("bun", "run", "test"), stop()],
    expect: [
      { id: "test-after-migration", relevantAt: 0 },
      { id: "reversible-migrations", relevantAt: 0 },
      { id: "vitest-for-tests", relevantAt: 1 },
    ],
    allow: ["postgres-prod"],
  },
  {
    id: "migration-run-tool",
    klass: "migration",
    prompt: "Apply the pending migrations.",
    events: [cmd("npx", "drizzle-kit", "migrate"), stop()],
    expect: [{ id: "test-after-migration", relevantAt: 0, conflictAt: 1 }, { id: "drizzle-orm", relevantAt: 0 }],
    allow: ["postgres-prod"],
  },

  // ============ auth / security ============
  {
    id: "auth-client-conflict",
    klass: "auth",
    prompt: "Fix the login flow.",
    events: [read("src/auth/login.ts"), edit("src/components/AuthForm.tsx")],
    expect: [{ id: "auth-server-side", relevantAt: 0, conflictAt: 1 }],
    lateEmergingId: "auth-server-side",
  },
  {
    id: "secret-logging-conflict",
    klass: "logging",
    prompt: "Fix the session redirect bug.",
    events: [
      read("src/auth/session.ts"),
      read("src/logger.ts"),
      edit("src/auth/session.ts"),
      write("src/logger.ts", "logger.info({ userId, accessToken })"),
    ],
    expect: [
      { id: "auth-server-side", relevantAt: 0 },
      { id: "no-secrets-in-logs", relevantAt: 1, conflictAt: 3 },
    ],
    allow: ["pino-logger"],
    lateEmergingId: "no-secrets-in-logs",
  },
  {
    id: "env-secrets",
    klass: "logging",
    prompt: "Wire up the API keys.",
    events: [edit(".env.local", "STRIPE_SECRET=sk_live_x")],
    expect: [{ id: "secrets-in-env", relevantAt: 0 }],
  },

  // ============ deployment ============
  {
    id: "deploy-vercel-conflict",
    klass: "deployment",
    prompt: "Ship the latest changes.",
    events: [cmd("vercel", "--prod")],
    expect: [{ id: "deploy-fly", conflictAt: 0 }],
    lateEmergingId: "deploy-fly",
  },
  {
    id: "deploy-fly-ok",
    klass: "deployment",
    prompt: "Deploy the app to production.",
    events: [cmd("flyctl", "deploy")],
    expect: [{ id: "deploy-fly", relevantAt: 0 }],
  },
  {
    id: "ci-workflow",
    klass: "deployment",
    prompt: "Add a build step.",
    events: [edit(".github/workflows/ci.yml")],
    expect: [{ id: "ci-github-actions", relevantAt: 0 }],
  },

  // ============ jobs / queues ============
  {
    id: "jobs-competing-lib",
    klass: "jobs",
    prompt: "Send welcome emails in the background.",
    events: [cmd("npm", "install", "agenda")],
    expect: [{ id: "bullmq-jobs", conflictAt: 0 }, { id: "bun-not-npm", conflictAt: 0 }],
    allow: ["pin-exact-deps"],
    lateEmergingId: "bullmq-jobs",
  },
  {
    id: "jobs-worker-file",
    klass: "jobs",
    prompt: "Add a retry to the email job.",
    events: [edit("src/workers/email.worker.ts")],
    expect: [{ id: "bullmq-jobs", relevantAt: 0 }],
    lateEmergingId: "bullmq-jobs",
  },

  // ============ formatting / style ============
  {
    id: "lint-eslint",
    klass: "formatting",
    prompt: "Clean up the lint warnings.",
    events: [cmd("eslint", "src", "--fix")],
    expect: [{ id: "eslint-lint", relevantAt: 0 }],
  },
  {
    id: "format-prettier",
    klass: "formatting",
    prompt: "Format the codebase.",
    events: [cmd("prettier", "--write", "src")],
    expect: [{ id: "prettier-format", relevantAt: 0 }],
  },
  {
    id: "frontend-vue-conflict",
    klass: "formatting",
    prompt: "Add a settings panel.",
    events: [cmd("bun", "add", "vue")],
    expect: [{ id: "react-ui", conflictAt: 0 }, { id: "bun-not-npm", relevantAt: 0 }],
    allow: ["pin-exact-deps"],
    lateEmergingId: "react-ui",
  },
  {
    id: "frontend-tailwind-ok",
    klass: "formatting",
    prompt: "Set up styling.",
    events: [cmd("bun", "add", "tailwindcss"), edit("tailwind.config.ts")],
    expect: [{ id: "tailwind-styles", relevantAt: 0 }],
    allow: ["bun-not-npm", "pin-exact-deps", "react-ui"],
    lateEmergingId: "tailwind-styles",
  },

  // ============ generated / lockfiles ============
  {
    id: "generated-edit-conflict",
    klass: "generated",
    prompt: "Tweak the API client types.",
    events: [edit("src/api/types.generated.ts")],
    expect: [{ id: "no-edit-generated", conflictAt: 0 }],
    lateEmergingId: "no-edit-generated",
  },
  {
    id: "lockfile-edit-conflict",
    klass: "generated",
    prompt: "Resolve the dependency conflict.",
    events: [edit("bun.lock")],
    expect: [
      { id: "no-edit-lockfile", conflictAt: 0 },
      { id: "no-edit-generated", conflictAt: 0 },
    ],
    allow: ["bun-not-npm"],
    lateEmergingId: "no-edit-lockfile",
  },

  // ============ validation / caching ============
  {
    id: "validation-joi-conflict",
    klass: "validation",
    prompt: "Parse the incoming webhook payload.",
    events: [cmd("npm", "install", "joi")],
    expect: [{ id: "zod-validation", conflictAt: 0 }, { id: "bun-not-npm", conflictAt: 0 }],
    allow: ["pin-exact-deps"],
    lateEmergingId: "zod-validation",
  },
  {
    id: "cache-memcached-conflict",
    klass: "validation",
    prompt: "Add caching to the product endpoint.",
    events: [cmd("npm", "install", "memcached")],
    expect: [{ id: "redis-cache", conflictAt: 0 }, { id: "bun-not-npm", conflictAt: 0 }],
    allow: ["pin-exact-deps"],
    lateEmergingId: "redis-cache",
  },
  {
    id: "logger-pino-ok",
    klass: "logging",
    prompt: "Add request logging.",
    events: [cmd("bun", "add", "pino"), write("src/logger.ts", "export const logger = pino()")],
    expect: [{ id: "pino-logger", relevantAt: 0 }],
    allow: ["bun-not-npm", "pin-exact-deps", "no-secrets-in-logs"],
  },

  // ============ negatives (nothing should be delivered) ============
  {
    id: "neg-readme",
    klass: "negative",
    prompt: "Update the README with setup instructions.",
    events: [edit("README.md"), read("docs/guide.md")],
    expect: [],
  },
  {
    id: "neg-dark-mode",
    klass: "negative",
    prompt: "Add a dark mode toggle to the header.",
    events: [edit("src/components/Header.tsx"), read("src/theme.ts")],
    expect: [],
  },
  {
    id: "neg-refactor",
    klass: "negative",
    prompt: "Rename the helper function.",
    events: [edit("src/utils/strings.ts"), read("src/utils/index.ts")],
    expect: [],
  },
];
