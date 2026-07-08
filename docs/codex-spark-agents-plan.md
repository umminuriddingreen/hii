# Codex Spark Agents Plan

Purpose: use short-lived Codex agents as bounded probes around HII work, with one main agent retaining edit, approval, destructive-action, and final integration control.

## Preflight

Run these before spawning agents:

```sh
hii health --text
hii caps show
hii probe --json
hii context --json
git status --short
```

Rules for every Spark agent:

- Work inside `/Users/ummi/hii` unless the prompt names another coordinate.
- Do not reset, revert, delete, publish, push, or touch secrets.
- Treat `/Users/ummi/hii` as the only current HII surface.
- Treat `/Users/ummi/.hii/capabilities.json` as possibly stale if it mentions `hii-old`.
- Report exact files read, commands run, findings, blockers, and recommended next action.
- If editing is allowed, keep edits scoped and verify with `npm run build`.

## Spawn Set

### Spark 1: Worktree Probe Auditor

Model: `gpt-5.5`
Reasoning: high
Mode: read-only
Coordinate: `/Users/ummi/hii`, `hii probe --json`, `git status --short`

Prompt:

```text
You are Spark 1, a read-only HII worktree probe auditor.

Inspect /Users/ummi/hii. Run:
- hii probe --json
- hii context --json
- git status --short
- rg -n "hii-old|legacyRuntime|hii legacy|terminal --legacy|old Python" /Users/ummi/hii /Users/ummi/bin/hii /opt/homebrew/bin/hii

Do not edit files. Determine whether the worktree probe covers all modified, deleted, staged, untracked, and stale legacy-runtime cases. Return findings with file paths and exact commands run.
```

### Spark 2: Single-HII Doorway Verifier

Model: `gpt-5.5`
Reasoning: low
Mode: read-only
Coordinate: `/Users/ummi/bin/hii`, `/opt/homebrew/bin/hii`, global `hii`

Prompt:

```text
You are Spark 2, a read-only HII doorway verifier.

Verify that every global HII doorway resolves to the current Node CLI under /Users/ummi/hii.
Run:
- which -a hii
- sed -n '1,40p' /Users/ummi/bin/hii
- sed -n '1,40p' /opt/homebrew/bin/hii
- hii health --text
- hii probe

Do not edit files. Report whether any path still invokes the old Python runtime or mentions hii-old as an active runtime.
```

### Spark 3: Context API Parity Verifier

Model: `gpt-5.5`
Reasoning: low
Mode: read-only
Coordinate: `/Users/ummi/hii/lib/server/hii-agent-context.ts`, `/Users/ummi/hii/scripts/hii-cli.mjs`

Prompt:

```text
You are Spark 3, a read-only HII context parity verifier.

Compare the CLI context payload and server context payload. Confirm both expose:
- git branch
- raw status lines
- classified worktree probe counts
- worktree file sample
- stale legacy runtime probe
- current repo /Users/ummi/hii

Run targeted reads and, if dependencies are already installed, npm run build. Do not edit files. Report mismatches and exact lines.
```

### Spark 4: Build And Surface Smoke

Model: `gpt-5.5`
Reasoning: low
Mode: verify-only
Coordinate: `/Users/ummi/hii`, Next app

Prompt:

```text
You are Spark 4, a HII smoke verifier.

Run:
- npm run build
- node scripts/hii-cli.mjs probe
- node scripts/hii-cli.mjs context --json
- node scripts/hii-cli.mjs legacy --help

Do not edit files. Report pass/fail, warnings, and whether legacy refusal still works.
```

## Main-Agent Integration Loop

1. Spawn Spark 1 and Spark 2 first because they validate the one-HII invariant.
2. Patch only issues that block `hii probe`, global `hii`, or stale legacy-runtime clarity.
3. Spawn Spark 3 after code changes so API and CLI context stay aligned.
4. Spawn Spark 4 last for build and CLI smoke verification.
5. Main agent reviews all Spark final artifacts, applies any final scoped patches, reruns:

```sh
hii probe
hii context --json
hii health --text
hii caps show
npm run build
```

6. Final report must include:

- Track, owner, coordinate, state, next action for each Spark.
- Changed paths.
- Commands run and pass/fail.
- Remaining stale or unverified facts.
