import { z } from "zod";
import { normalizeSlashes } from "../../utils/glob.ts";
import { PHASES, type Phase } from "./vocab.ts";

/**
 * The normalized, HOST-INDEPENDENT agent event.
 *
 * This is the single seam between a host (Claude Code, Codex, Cursor) and the
 * overseer. A host adapter's ONLY job is to map its native hook payload into this
 * shape — it contains NO relevance logic. The model is deliberately SMALL: it is a
 * structural observation of one workflow step, not a transcript. No file contents,
 * no model output, no prose beyond a short optional `text` cue.
 *
 * Provenance note: an AgentEvent is OBSERVATIONAL ONLY. It can never create or
 * strengthen an authoritative memory (§26). Nothing here is persisted as a
 * preference or signal.
 */
export interface AgentEvent {
  /** Which host produced the event. */
  host: "claude" | "codex" | "cursor";
  /** Opaque per-session id (bounds workflow state + the delivery ledger). */
  sessionId: string;
  /** Monotonic sequence within the session (0-based). */
  seq: number;
  /** Normalized lifecycle phase. */
  phase: Phase;
  /** Raw host tool name when applicable (e.g. "Bash", "Edit"). */
  tool?: string;
  /** Working directory, when the host reports it. */
  cwd?: string;
  /** Canonical repo identity, when resolvable. */
  repo?: string;
  /** Files this event touches (repo-relative or absolute; normalized to `/`). */
  files?: Array<{ path: string; extension?: string }>;
  /** A parsed command, for `command`/`pre_tool`/`post_tool` shell events. */
  command?: {
    executable?: string;
    argv?: string[];
    operation?: string;
  };
  /**
   * Pre-attached canonical domains (adapter may leave empty; the overseer infers).
   * Observational only.
   */
  domains?: string[];
  /** Pre-attached operations (adapter may leave empty; the overseer infers). */
  operations?: string[];
  /**
   * A short, sanitized observational text cue — a command string or an edited
   * snippet — used ONLY for conservative token-cue extraction (§16). Never stored,
   * never classified as intent. Bounded length.
   */
  text?: string;
}

/** Max chars of observational `text` we retain for cue extraction. */
export const MAX_EVENT_TEXT = 2000;

const FileSchema = z
  .object({
    path: z.string().min(1),
    extension: z.string().optional(),
  })
  .strict();

const CommandSchema = z
  .object({
    executable: z.string().optional(),
    argv: z.array(z.string()).optional(),
    operation: z.string().optional(),
  })
  .strict();

/**
 * Tolerant schema for a RAW incoming event (e.g. from a CLI/stdin). Unknown host
 * strings and phases are rejected here so a malformed event fails fast and
 * fail-open at the call site rather than corrupting workflow state.
 */
export const AgentEventSchema = z
  .object({
    host: z.enum(["claude", "codex", "cursor"]),
    sessionId: z.string().min(1).max(128),
    seq: z.number().int().min(0),
    phase: z.enum(PHASES),
    tool: z.string().max(64).optional(),
    cwd: z.string().optional(),
    repo: z.string().optional(),
    files: z.array(FileSchema).max(256).optional(),
    command: CommandSchema.optional(),
    domains: z.array(z.string()).max(32).optional(),
    operations: z.array(z.string()).max(32).optional(),
    text: z.string().optional(),
  })
  .strict();

export type RawAgentEvent = z.infer<typeof AgentEventSchema>;

/**
 * Validate + normalize a raw event into a canonical AgentEvent. Normalizes file
 * paths to forward slashes, lowercases extensions, bounds `text`. Throws ZodError
 * on a structurally invalid event (callers fail open).
 */
export function normalizeEvent(raw: unknown): AgentEvent {
  const e = AgentEventSchema.parse(raw);
  const files = e.files?.map((f) => {
    const path = normalizeSlashes(f.path);
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    const ext = f.extension
      ? f.extension.replace(/^\./, "").toLowerCase()
      : dot > slash && dot < path.length - 1
        ? path.slice(dot + 1).toLowerCase()
        : undefined;
    return ext ? { path, extension: ext } : { path };
  });
  const text = e.text ? e.text.slice(0, MAX_EVENT_TEXT) : undefined;
  return {
    host: e.host,
    sessionId: e.sessionId,
    seq: e.seq,
    phase: e.phase,
    tool: e.tool,
    cwd: e.cwd,
    repo: e.repo,
    files,
    command: e.command,
    domains: e.domains,
    operations: e.operations,
    text,
  };
}

/** Convenience type guard — true when a value parses as a valid AgentEvent. */
export function isAgentEvent(raw: unknown): boolean {
  return AgentEventSchema.safeParse(raw).success;
}
