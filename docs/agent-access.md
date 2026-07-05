# Agent Access To HII

HII should be easy for agents to use without guessing paths or reading secrets.

## First Commands

```sh
hii context --json
hii health --text
hii caps show
hii og status
```

`hii context --json` is the preferred bootstrap command. It returns:

- canonical repo/runtime paths
- current git branch, dirty files, and recent commits
- backend capability summaries
- local runtime pointers
- recent capability jobs
- guardrails for safe edits
- ranked next actions from OG

The output is secret-safe by design: it reports env and file presence, not raw
token values.

## Operational Graph

Use OG when a conversation should become persistent context:

```sh
hii og capture "short summary of the turn or task"
```

This appends to `~/.hii/og/events.jsonl` and ranks likely next paths from local
repo, bridge, capability, job, and runtime context.

## Guardrails

- Do not touch `.claude/`, `.hermes/`, `life/`, screenshots, or other generated
  local state unless the task explicitly scopes them.
- Do not copy or print raw secrets.
- Do not reset or delete unclear user work.
- Do not fetch, push, publish, upload, or call external services unless the
  user explicitly asks for that external action.
- `hii ship` is local-only by default. `hii ship --push` is the explicit
  external publish command.
- Run `npm run build` after meaningful HII product edits.
