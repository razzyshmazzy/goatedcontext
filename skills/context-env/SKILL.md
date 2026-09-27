---
name: context-env
description: >-
  Discover and run reusable development environments (e.g. supabase-test,
  stripe-test, openai-dev) via the `ctx` CLI. Secrets are injected into the child
  process only and never printed.
---

# context-env

Reusable environments bundle the environment variables (including secret values)
needed to run a task against a service, without exposing those values.

## Discover

```bash
ctx env list
ctx get --cwd "$PWD" --task "<task>"   # includes an "environments" section
```

The `available` flag tells you whether every required secret is present.

## Run a command inside an environment

```bash
ctx env run <name> -- <command>
```

For example:

```bash
ctx env run supabase-test -- npm test
```

The child process receives the environment's variables; `ctx` never prints the
values. Multiple environments can be composed:

```bash
ctx env run supabase-test openai-dev -- npm test
```

## Hard rules

- Never print, echo, or log secret values.
- Never copy secret values into code, preferences, or SKILL files.
- Prefer `ctx env run` over reading secrets yourself.
