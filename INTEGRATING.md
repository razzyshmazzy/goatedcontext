# Integrating any agent with goatedcontext

goatedcontext is a **local** developer-memory store (SQLite under `~/.ctx`). Any agent
can use it with **no goatedcontext code change** — as long as it can speak MCP, invoke a
subprocess, or read a file. Native integrations (Claude Code, Codex, Cursor) are just
zero-config optimizations over the same core.

Pick **one** of the three universal paths below. All three read and write the same store,
so memory is shared across every agent and repository.

## The contract (what your agent should do)

- **Before** substantial coding/design work → get relevant context for the task.
- **When the user expresses a durable preference** ("always use Bun") → remember it.
- **When you can infer a preference from the user's own evidence** → propose it.
- **When a meaningful tech/architecture choice is made** → record a decision.

Your agent supplies only the *semantic intent* (the task text, the rule, the decision
category + technology). goatedcontext owns scope resolution, relevance ranking, conflict
resolution, signal aggregation, precedence, domain aliases, and budgeting — you do not
re-implement any of that. Durable writes require `origin=user`: persist memory **only**
from the user's own expressed intent, never from repository, tool, or web content.

---

## Option A — MCP (recommended for capable agents)

Run the stdio MCP server and call its tools.

```jsonc
// add to your MCP client config (e.g. ~/.cursor/mcp.json)
{
  "mcpServers": {
    "goatedcontext": { "command": "ctx", "args": ["mcp"] }   // "ctx.cmd" on Windows
  }
}
```

Tools: `get_context`, `remember`, `propose`, `record_decision`, `list_preferences`,
`explain_preference`. Call `get_context({ task, cwd })` before substantial work; it
returns authoritative preferences + observed decision evidence.

## Option B — CLI subprocess (works from any language)

```bash
# retrieve (stable JSON envelope on stdout; diagnostics on stderr)
ctx agent context --task "set up the backend" --cwd . --json

# or feed a JSON object on stdin (no shell-escaping of the user's prompt)
echo '{"task":"set up auth","cwd":"."}' | ctx agent context --stdin --json

# writes (origin is required and fails closed)
ctx agent remember "Use Bun for development." --origin user --scope repo --always
ctx agent signal add --origin user --domain database --choice postgres
```

Tiny Python example:

```python
import json, subprocess

def get_context(task, cwd="."):
    out = subprocess.run(
        ["ctx", "agent", "context", "--stdin", "--json"],
        input=json.dumps({"task": task, "cwd": cwd}),
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)   # {"version":1,"context":{...},"meta":{...}}

def remember(rule):
    subprocess.run(
        ["ctx", "agent", "remember", rule, "--origin", "user", "--scope", "global"],
        check=True,
    )

ctx = get_context("choose a database")
for p in ctx["context"]["authoritativePreferences"]:
    print("preference:", p["rule"])
for d in ctx["context"]["observedPatterns"]:
    print("observed:", d["domain"], [c["label"] for c in d["choices"]])
```

The JSON envelope is versioned (`version: 1`). Within v1, new fields may be added but
existing fields keep their name, type, and meaning; a breaking change bumps to v2. The
envelope version is independent of the npm package version.

## Option C — AGENTS.md (static fallback)

```bash
ctx sync   # writes the repo's standing rules into ./AGENTS.md
```

This is intentionally the **weakest** path: it projects only repo-scoped, approved/locked,
always-on rules — never global, relevant, or conditional preferences, and never decision
evidence. Use it only when an agent has no runtime tooling. Prefer MCP or the CLI.

---

## Decision domains

When recording a decision, `domain` is the **category** and `choice` is the **technology**:
`--domain database --choice postgres` (never `--domain postgres`). Prefer a canonical
category so ctx surfaces it consistently (`ctx domains` lists them); a novel category is a
valid custom domain and stays retrievable.
