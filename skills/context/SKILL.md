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

## Automatic retrieval (default)

Relevant developer context is usually injected for you automatically: a
`ctx` prompt hook runs on each user message and, when it finds relevant
preferences, prepends a `<ctx-developer-context>` block to the conversation.
When you see that block, it is authoritative — apply it. If a repo preference and
a global preference conflict, the repo preference wins. If no block appears, there
was no relevant stored guidance for this turn; proceed normally.

## Manual retrieval (refresh / special cases)

You normally do NOT need to call `ctx get` yourself, because the hook already did.
Call it manually only to refresh after the task changes substantially, to look up a
different task than the user's prompt, or when debugging:

```bash
ctx get --cwd "$PWD" --task "<brief description of the current task>"
```

It returns concise JSON (repo, relevance-filtered conflict-resolved preferences,
available environments). It is read-only and safe to call anytime. Never ask `ctx`
for secrets — it does not return them, by design.
