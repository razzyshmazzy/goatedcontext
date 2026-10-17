import { canonicalDomain, collectDomainsFromText } from "../signals/domains.ts";
import { languageForPath } from "../preferences/languages.ts";
import { normalizeSlashes } from "../../utils/glob.ts";
import type { AgentEvent } from "./event.ts";
import {
  type Artifact,
  type Operation,
  OPERATION_SET,
  SECRET_TOKEN_CUES,
} from "./vocab.ts";

/**
 * Deterministic FEATURE EXTRACTION: AgentEvent → sparse structural features.
 *
 * This is the only place that interprets a raw event. It reuses the existing
 * domain inference (`collectDomainsFromText`) and language inference
 * (`languageForPath`) so the overseer never invents a second taxonomy; on top of
 * that it adds a tiny, explicit command→operation table and a path→artifact table.
 * Pure, allocation-light, no embeddings, no I/O.
 */
export interface EventFeatures {
  phase: string;
  tool?: string;
  executables: Set<string>;
  operations: Set<Operation>;
  domains: Set<string>; // canonical decision domains
  languages: Set<string>;
  packages: Set<string>;
  artifacts: Set<Artifact>;
  files: string[]; // normalized, forward-slash
  tokenCues: Set<string>; // matched conservative secret cues
  /** Flat sparse feature strings — the key space for the inverted index + dataset. */
  tags: Set<string>;
}

const PM_EXES = new Set(["npm", "pnpm", "yarn", "bun"]);
const TEST_RUNNERS = new Set(["vitest", "jest", "mocha", "ava", "pytest", "playwright", "cypress"]);
const DB_CLIENTS = new Set(["psql", "mysql", "sqlite3", "mongo", "mongosh", "redis-cli"]);
const MIGRATION_TOOLS = new Set(["prisma", "drizzle-kit", "knex", "alembic", "sequelize", "rails"]);
const DEPLOY_TOOLS = new Set(["fly", "flyctl", "vercel", "wrangler", "netlify"]);

/** A single `*.ext` → canonical domain hint (beyond what paths already imply). */
const EXT_DOMAIN: Record<string, string> = { sql: "database" };

/** Conservative logging-call cues (identifier-shaped, not arbitrary regex). */
const LOG_CALL_CUES = [
  "logger.",
  "console.log",
  "console.info",
  "console.debug",
  "console.warn",
  "console.error",
  "log.info",
  "log.debug",
  ".info(",
  ".debug(",
  ".warn(",
  ".error(",
];

/** Strip a path/extension from an executable and lowercase it. */
function baseExecutable(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let s = normalizeSlashes(raw).trim().toLowerCase();
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/\.(exe|cmd|bat|ps1)$/, "");
  return s || undefined;
}

/** True when a token looks like a bare package name (not a flag/path/number). */
function looksLikePackage(tok: string): boolean {
  if (!tok || tok.startsWith("-")) return false;
  if (tok.includes("/") && !tok.startsWith("@")) return false; // path, not a scoped pkg
  return /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)?$/i.test(tok);
}

interface CommandParse {
  operation?: Operation;
  packages: string[];
  domains: string[];
  /** Extra executables surfaced from a runner subcommand (e.g. `npx jest` → jest). */
  executables?: string[];
}

/** Tools whose invocation via npx/bunx should count as using that tool. */
const NPX_TOOLS = new Set([
  ...["vitest", "jest", "mocha", "ava", "pytest", "playwright", "cypress"],
  ...["prisma", "drizzle-kit", "knex", "alembic", "sequelize"],
  ...["eslint", "prettier", "ruff", "black"],
]);

/**
 * Map a parsed command to one operation + any package names + domain hints. The
 * table is intentionally small and explicit — the common tools, nothing exotic.
 */
function parseCommand(exe: string, argv: string[]): CommandParse {
  const out: CommandParse = { packages: [], domains: [] };
  const sub = (argv[0] ?? "").toLowerCase();
  const rest = argv.slice(1).filter((a) => !a.startsWith("-"));

  // Package managers. The `package-manager` decision domain is attached only to
  // dependency-MUTATING actions (install/remove) — running a script (`bun run x`)
  // or tests is NOT a package-manager decision and must not surface that preference.
  if (PM_EXES.has(exe)) {
    if (["install", "i", "ci", "add"].includes(sub)) {
      out.operation = "package_install";
      out.domains.push("package-manager");
      out.packages = rest.filter(looksLikePackage);
    } else if (["remove", "uninstall", "rm", "un"].includes(sub)) {
      out.operation = "package_remove";
      out.domains.push("package-manager");
      out.packages = rest.filter(looksLikePackage);
    } else if (sub === "test" || (sub === "run" && (argv[1] ?? "").toLowerCase() === "test")) {
      out.operation = "test_run";
      out.domains.push("testing");
    } else if (["run", "exec", "x", "start", "dev", "build"].includes(sub)) {
      out.operation = "package_run";
    } else if (!sub) {
      out.operation = "package_install"; // bare `npm` / `bun install`-ish
      out.domains.push("package-manager");
    }
    return out;
  }

  // One-off runners (`npx`, `bunx`). These execute a tool transiently — they are NOT
  // a package-manager choice, so they never carry the package-manager domain.
  if (exe === "npx" || exe === "bunx" || exe === "pnpx") {
    const tool = sub;
    if (NPX_TOOLS.has(tool)) out.executables = [tool];
    if (TEST_RUNNERS.has(tool)) {
      out.operation = "test_run";
      out.domains.push("testing");
    } else if (MIGRATION_TOOLS.has(tool)) {
      out.operation = "migration_run";
      out.domains.push("database");
    } else {
      out.operation = "package_run";
    }
    return out;
  }

  if (exe === "pip" || exe === "pip3") {
    if (sub === "install") {
      out.operation = "package_install";
      out.domains.push("package-manager");
    } else if (sub === "uninstall") {
      out.operation = "package_remove";
      out.domains.push("package-manager");
    }
    out.packages = rest.filter(looksLikePackage);
    return out;
  }

  if (exe === "cargo" || exe === "go") {
    if (sub === "test") {
      out.operation = "test_run";
      out.domains.push("testing");
    } else if (sub === "add" || sub === "get") {
      out.operation = "package_install";
      out.domains.push("package-manager");
    } else if (sub === "build" || sub === "run") {
      out.operation = "package_run";
    }
    return out;
  }

  if (TEST_RUNNERS.has(exe)) {
    out.operation = "test_run";
    out.domains.push("testing");
    return out;
  }
  if (DB_CLIENTS.has(exe)) {
    out.operation = "db_query";
    out.domains.push("database");
    return out;
  }
  if (MIGRATION_TOOLS.has(exe)) {
    out.domains.push("database");
    if (sub === "migrate" || sub === "db:migrate" || sub.startsWith("migrat") || sub === "upgrade" || sub === "push") {
      out.operation = "migration_run";
    }
    return out;
  }
  if (DEPLOY_TOOLS.has(exe) || (exe === "kubectl" && sub === "apply") || (exe === "docker" && sub === "push")) {
    if (exe === "wrangler" && !(sub === "deploy" || sub === "publish")) return out;
    out.operation = "deploy";
    out.domains.push("infrastructure");
    return out;
  }
  if (exe === "eslint" || exe === "ruff") out.operation = "lint";
  else if (exe === "prettier" || exe === "black" || exe === "gofmt") out.operation = "format";
  else if (exe === "git") out.operation = "git_op";
  return out;
}

/** Classify a path into zero-or-more artifact roles + domain hints. */
function classifyPath(path: string): { artifacts: Artifact[]; domains: string[] } {
  const p = normalizeSlashes(path).toLowerCase();
  const base = p.slice(p.lastIndexOf("/") + 1);
  const artifacts: Artifact[] = [];
  const domains: string[] = [];

  const MANIFESTS = ["package.json", "pyproject.toml", "cargo.toml", "go.mod", "requirements.txt"];
  const LOCKS = ["package-lock.json", "bun.lockb", "bun.lock", "yarn.lock", "pnpm-lock.yaml", "cargo.lock", "poetry.lock"];
  if (MANIFESTS.includes(base)) {
    artifacts.push("manifest");
    domains.push("package-manager");
  }
  if (LOCKS.includes(base)) {
    artifacts.push("lockfile");
    artifacts.push("generated");
    domains.push("package-manager");
  }
  if (/(^|\/)migrations?\//.test(p) || (p.endsWith(".sql") && /migrat/.test(p))) {
    artifacts.push("migration");
    domains.push("database");
  }
  if (/(^|\/)(logger|logging|log)\.[a-z]+$/.test(base) || base === "logger.ts" || base === "logger.js") {
    artifacts.push("logger");
  }
  if (/\.(test|spec)\.[a-z]+$/.test(base) || /(^|\/)(tests?|__tests__)\//.test(p)) {
    artifacts.push("test");
    domains.push("testing");
  }
  if (base === ".env" || base.startsWith(".env.")) {
    artifacts.push("env_file");
    domains.push("security");
  }
  if (/\.generated\.[a-z]+$/.test(base) || /\.min\.[a-z]+$/.test(base) || /(^|\/)(dist|build)\//.test(p)) {
    artifacts.push("generated");
  }
  if (/(^|\/)\.github\/workflows\//.test(p)) {
    artifacts.push("ci");
    domains.push("infrastructure");
  }
  return { artifacts, domains };
}

/** Extract the conservative secret token cues present in a string. */
function matchSecretCues(text: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const low = text.toLowerCase();
  for (const cue of SECRET_TOKEN_CUES) if (low.includes(cue)) out.add(cue);
  return out;
}

/** True when observational text contains a conservative logging-call cue. */
function hasLogCall(text: string | undefined): boolean {
  if (!text) return false;
  const low = text.toLowerCase();
  return LOG_CALL_CUES.some((c) => low.includes(c));
}

/**
 * Extract sparse structural features from a normalized AgentEvent. Deterministic
 * and pure; the returned sets are the activation-matching surface.
 */
export function extractFeatures(event: AgentEvent): EventFeatures {
  const executables = new Set<string>();
  const operations = new Set<Operation>();
  const domains = new Set<string>();
  const languages = new Set<string>();
  const packages = new Set<string>();
  const artifacts = new Set<Artifact>();
  const files: string[] = [];

  // Adapter-supplied hints (observational; still vocabulary-checked).
  for (const d of event.domains ?? []) domains.add(canonicalDomain(d));
  for (const o of event.operations ?? []) if (OPERATION_SET.has(o)) operations.add(o as Operation);

  // Command parsing.
  const exe = baseExecutable(event.command?.executable);
  const argv = event.command?.argv ?? [];
  if (exe) {
    executables.add(exe);
    const parsed = parseCommand(exe, argv);
    if (parsed.operation) operations.add(parsed.operation);
    for (const d of parsed.domains) domains.add(canonicalDomain(d));
    for (const p of parsed.packages) packages.add(p.toLowerCase());
    for (const x of parsed.executables ?? []) executables.add(x);
  }

  // Files → languages, artifacts, domains.
  for (const f of event.files ?? []) {
    const path = normalizeSlashes(f.path);
    files.push(path);
    const lang = languageForPath(path);
    if (lang) languages.add(lang);
    const ext = f.extension ?? (path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "");
    if (ext && EXT_DOMAIN[ext]) domains.add(EXT_DOMAIN[ext]!);
    const cls = classifyPath(path);
    for (const a of cls.artifacts) artifacts.add(a);
    for (const d of cls.domains) domains.add(canonicalDomain(d));
  }

  // Phase/tool-driven file operations.
  const toolLower = event.tool?.toLowerCase();
  const isWrite =
    event.phase === "file_write" ||
    toolLower === "edit" ||
    toolLower === "write" ||
    toolLower === "notebookedit" ||
    toolLower === "multiedit";
  const isRead = event.phase === "file_read" || toolLower === "read";
  if (files.length > 0) {
    if (isWrite) {
      operations.add("file_edit");
      operations.add("file_write");
      if (artifacts.has("migration")) operations.add("migration_edit");
    } else if (isRead) {
      operations.add("file_read");
    }
  }

  // Text-derived domains come ONLY from command argv + the observational snippet —
  // NOT from file basenames. A basename like `index.ts` would otherwise match the
  // classifier's `database` keyword ("index"); file roles are instead captured
  // structurally via classifyPath above. Observational text only.
  const textParts: string[] = [];
  if (event.text) textParts.push(event.text);
  if (argv.length) textParts.push(argv.join(" "));
  const combinedText = textParts.join(" ");
  if (combinedText.trim()) {
    for (const d of collectDomainsFromText(combinedText)) domains.add(d);
  }
  const tokenCues = matchSecretCues(event.text ? `${event.text} ${argv.join(" ")}` : argv.join(" "));
  if ((isWrite || event.phase === "command") && hasLogCall(event.text)) {
    operations.add("log_write");
  }

  // Flat sparse feature strings for the inverted index + dataset rows.
  const tags = new Set<string>();
  tags.add(`phase:${event.phase}`);
  if (toolLower) tags.add(`tool:${toolLower}`);
  for (const e of executables) tags.add(`exe:${e}`);
  for (const o of operations) tags.add(`op:${o}`);
  for (const d of domains) tags.add(`domain:${d}`);
  for (const l of languages) tags.add(`lang:${l}`);
  for (const p of packages) tags.add(`pkg:${p}`);
  for (const a of artifacts) tags.add(`artifact:${a}`);
  for (const c of tokenCues) tags.add(`tok:${c}`);

  return { phase: event.phase, tool: toolLower, executables, operations, domains, languages, packages, artifacts, files, tokenCues, tags };
}
