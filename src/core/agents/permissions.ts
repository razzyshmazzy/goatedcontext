/**
 * The SAFE auto-allow command surface for seamless memory writes (0.3.5).
 *
 * Claude Code and Codex both prompt the user to approve every shell command by
 * default, which destroys the "memory just happens" UX when the agent runs `ctx`.
 * This module is the SINGLE source of truth for which `ctx` commands are safe to
 * auto-approve, rendered into each host's native, NARROW permission mechanism:
 *
 *   - Claude Code — `permissions.allow`/`deny` rules (`Bash(ctx remember:*)`) in
 *     `~/.claude/settings.json`. Claude splits a command on shell operators
 *     (`&&`, `||`, `;`, `|`, `|&`, `&`, newlines) and requires EACH sub-command to
 *     match independently, so a narrow prefix cannot be turned into arbitrary
 *     execution by chaining.
 *   - Codex — argv-based `prefix_rule(pattern=[...], decision="allow")` in a
 *     dedicated `$CODEX_HOME/rules/ctx.rules` file. Matching is token-array based and
 *     splits shell chains per-segment; an unsplittable script falls back to prompting.
 *
 * Both are injection-safe BY THE HOST, which is why we only install on these two.
 * Cursor's `terminalAllowlist` is RAW-PREFIX (CVE-documented chaining bypass), so we
 * deliberately do NOT auto-allow anything there (see the Cursor adapter).
 *
 * The surface is deliberately tiny: low-risk memory/context reads + bounded additive
 * writes. Destructive or human-review commands (`forget`, `signal clear`,
 * `prefs approve/reject`) and everything else (`env`, `import`, `setup`, `install`,
 * `repair`, `uninstall`, …) are never auto-allowed — they keep prompting as normal.
 */

/**
 * The ctx launcher spellings to allow for a platform. On Windows the memory skill
 * invokes `ctx.cmd` (plain `ctx` resolves to the PowerShell shim), so both are
 * allowed — never only `ctx` (spec §11).
 */
export function ctxLaunchers(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["ctx", "ctx.cmd"] : ["ctx"];
}

/**
 * Low-risk ctx memory/context commands that are safe to auto-approve. Each entry is
 * the argv tokens AFTER the launcher.
 *
 * The three WRITES are the dedicated AGENT surface (`ctx agent remember|propose|signal
 * add`), which fails closed without an explicit `--origin` — it can never silently
 * assume user intent. The BARE `ctx remember|propose|signal add` commands are the human
 * convenience path and are deliberately NOT in this set, so an agent executing a
 * memory-write instruction found in untrusted content (which would be written as bare
 * `ctx remember …`, with no origin) is NOT silently auto-approved — normal host approval
 * applies. READS are harmless.
 */
export const CTX_ALLOWED_COMMANDS: readonly (readonly string[])[] = [
  // bounded memory writes — AGENT surface only (provenance required, fails closed)
  ["agent", "remember"],
  ["agent", "propose"],
  ["agent", "signal", "add"],
  // reads
  ["prefs"],
  ["why"],
  ["signals"],
  ["history"],
  ["conflicts"],
];

/**
 * Rule prefixes goatedcontext auto-allowed in PRIOR releases (0.3.5/0.3.6) but no
 * longer does: the bare, human-convenience write commands. Repair/upgrade must REMOVE
 * these from a user's config — leaving them would preserve the very bypass this release
 * closes (an agent running a bare `ctx remember` from untrusted content with no origin).
 * Kept here only so the installer can prune them; never installed.
 */
export const CTX_RETIRED_ALLOWED_COMMANDS: readonly (readonly string[])[] = [
  ["remember"],
  ["propose"],
  ["signal", "add"],
];

/**
 * Commands a broad `ctx prefs` allow-prefix would otherwise cover but which MUST stay
 * gated: approving/rejecting a proposal is a human-review action the agent must not
 * perform silently. Rendered as an explicit higher-precedence gate (Claude `deny`,
 * Codex `prompt`) so `ctx prefs` reads stay seamless while these keep prompting.
 * Destructive commands (`forget`, `signal clear`) are simply never allowed, so they
 * need no explicit gate.
 */
export const CTX_GATED_COMMANDS: readonly (readonly string[])[] = [
  ["prefs", "approve"],
  ["prefs", "reject"],
];

// ── Claude Code: settings.json permission rule strings ────────────────────────

/** Render a Claude `Bash(... :*)` prefix rule for a launcher + argv tokens. */
function claudeRule(launcher: string, cmd: readonly string[]): string {
  return `Bash(${[launcher, ...cmd].join(" ")}:*)`;
}

/** The allow + deny rule strings Claude should carry for a platform. */
export function claudePermissionRules(platform: NodeJS.Platform = process.platform): {
  allow: string[];
  deny: string[];
} {
  const launchers = ctxLaunchers(platform);
  const allow: string[] = [];
  const deny: string[] = [];
  for (const l of launchers) {
    for (const cmd of CTX_ALLOWED_COMMANDS) allow.push(claudeRule(l, cmd));
    for (const cmd of CTX_GATED_COMMANDS) deny.push(claudeRule(l, cmd));
  }
  return { allow, deny };
}

/**
 * EVERY Claude rule string goatedcontext could own, across all platforms AND all
 * releases — including the RETIRED bare-write rules (0.3.5/0.3.6). Used for
 * removal/cleanup and for the security migration: on repair, any owned rule not in the
 * current desired set is pruned, so a stale `Bash(ctx remember:*)` from an old install
 * is stripped. Detection never leaves a stray ctx rule behind.
 */
export function allClaudeOwnedRules(): { allow: Set<string>; deny: Set<string> } {
  const allow = new Set<string>();
  const deny = new Set<string>();
  for (const platform of ["win32", "linux"] as NodeJS.Platform[]) {
    const r = claudePermissionRules(platform);
    r.allow.forEach((s) => allow.add(s));
    r.deny.forEach((s) => deny.add(s));
    // Retired bare-write rules this installer must be able to strip from old configs.
    for (const l of ctxLaunchers(platform)) {
      for (const cmd of CTX_RETIRED_ALLOWED_COMMANDS) allow.add(claudeRule(l, cmd));
    }
  }
  return { allow, deny };
}

// ── Codex: execpolicy .rules file ─────────────────────────────────────────────

/** Bump when the rendered Codex rules body changes so stale files are re-synced. */
export const CODEX_RULES_VERSION = "2";

/** The goatedcontext-owned Codex rules filename (its own file; never config.toml). */
export const CODEX_RULES_FILENAME = "goatedcontext.rules";

/** Hidden ownership + version marker embedded at the top of the rules file. */
export const CODEX_RULES_MARKER = `# goatedcontext-managed:v${CODEX_RULES_VERSION}`;

function codexPrefixRule(pattern: readonly string[], decision: "allow" | "prompt", justification: string): string {
  const pat = pattern.map((p) => JSON.stringify(p)).join(", ");
  return (
    `prefix_rule(\n` +
    `    pattern = [${pat}],\n` +
    `    decision = ${JSON.stringify(decision)},\n` +
    `    justification = ${JSON.stringify(justification)},\n` +
    `)`
  );
}

/**
 * The full Codex `.rules` file body: `allow` rules for the safe set and explicit
 * `prompt` rules for the gated set (Codex is most-restrictive-wins, so the narrower
 * `prompt` rule beats the broader `prefs` allow). argv-based, so chaining a second
 * command onto an allowed prefix is evaluated independently and stays gated.
 */
export function renderCodexRulesFile(platform: NodeJS.Platform = process.platform): string {
  const launchers = ctxLaunchers(platform);
  const lines: string[] = [
    CODEX_RULES_MARKER,
    "# Auto-approve ONLY low-risk goatedcontext (ctx) memory/context commands.",
    "# Everything else — env, import, setup, install, repair, uninstall, forget,",
    "# signal clear, prefs approve/reject — stays gated by your global approval policy.",
    "# This file is goatedcontext-owned; edit via `ctx repair codex`, not by hand.",
    "",
  ];
  for (const l of launchers) {
    for (const cmd of CTX_ALLOWED_COMMANDS) {
      lines.push(codexPrefixRule([l, ...cmd], "allow", `ctx ${cmd.join(" ")}: safe goatedcontext memory/context command`));
    }
    for (const cmd of CTX_GATED_COMMANDS) {
      lines.push(codexPrefixRule([l, ...cmd], "prompt", `ctx ${cmd.join(" ")}: changes preference review state; keep gated`));
    }
  }
  return lines.join("\n") + "\n";
}
