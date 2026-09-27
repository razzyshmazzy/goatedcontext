---
name: context
description: >-
  Retrieve the developer's persistent preferences and available environments
  before making consequential engineering decisions (architecture, dependencies,
  data modeling, infrastructure, security, testing strategy, or other significant
  implementation choices). Backed by the local `ctx` CLI.
---

# context

Use this skill BEFORE any consequential engineering decision, including:

- architecture and service boundaries
- adding or choosing dependencies
- data modeling and schema design
- infrastructure and deployment choices
- security-sensitive changes
- testing strategy
- other significant implementation choices

## How to use

Run the `ctx` CLI to fetch the relevant subset of the developer's context for
the current repository and task:

```bash
ctx get --cwd "$PWD" --task "<brief description of the current task>"
```

The command returns concise JSON: the detected repository, a relevance-filtered
and conflict-resolved list of applicable preferences (repo-specific rules override
global ones), and the environments available here.

`ctx get` is read-only and safe to call as often as you like — including while
other agents are working in the same or other repositories. Call it before each
consequential decision rather than caching it.

Apply the returned preferences to your decision. If a repo preference and a
global preference conflict, the repo preference wins. If `ctx` returns an empty
preference list, there is no stored guidance for this task — proceed normally.

Never ask `ctx` for secrets — it does not return them, by design.
