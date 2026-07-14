# HII Agent Guide

## Required Product Context

Before planning or modifying HII, read:

- `docs/HII_AII_MASTER_CONTEXT.md`

This document defines the founder thesis, HII/AII boundary, current Context
Dock product scope, architecture constraints, deferred roadmap, trust model,
and required agent behavior. Historical brainstorms do not override the
current product decision.

This repo is an active multi-agent worktree. Codex, Claude, HII workers, and the user may all be editing or generating artifacts at the same time.

## Mission

HII is a local-first control plane for verified agent work.

The current product wedge is:

Human intent -> bounded agent/tool work -> logs/proof -> verification -> receipt -> reusable capability.

## Worktree Discipline

- Start with `hii context --json` for a machine-readable map of repo paths,
  runtime files, commands, capabilities, recent jobs, guardrails, and likely
  next actions.
- Then run `hii og status` when you need the operational graph's ranked next
  path from current repo, bridge, job, and runtime context.
- Check `git status --short` and targeted diffs before editing.
- Do not reset, delete, format, or rewrite files outside your scoped task.
- Treat broad untracked folders such as `.claude/`, `.hermes/`, screenshots, and `life/` as possibly owned by another agent or the user.
- Treat `/Users/ummi/hii` as the only current HII. Mine old checkouts for migration evidence only; do not add new dependencies on `/Users/ummi/hii-old`.
- Keep secrets reference-only. Never print raw token values or copy credential files into docs, logs, or commits.
- Complete work locally by default. Do not fetch, push, publish, upload, or call
  external services unless the user explicitly asks for that external action.
- Keep changes minimal and prefer small patches over rewrites.
- Read only the files needed for the current task.
- Do not restyle the whole app or rename product concepts unless explicitly asked.
- Do not claim something is verified unless a command or visible output proves it.
- If a command fails, report the failure and continue only when the next step is safe.
- If shell/tooling is blocked, stop and report instead of fighting it.

## Current Product Direction

- HII is a local-first control plane for verified agent work.
- The current implementation target is `hii today` + `/today` + unified context + stale job handling + standard receipts.
- Do not add new surfaces, capabilities, marketplace features, Creator Desk features, MCP catalog work, credits expansion, or decentralized compute features until the daily operational loop is reliable.
- Local terminal execution remains operator-controlled and local-only until a hardened remote runner exists.

## Verification

- Use `hii health --text` and `hii caps show` as compatibility-safe agent
  entrypoints.
- Use `npm run build` for app validation.
- Use `hii ship` only for local typecheck + commit. Use `hii ship --push` only
  after explicit user approval to publish externally.
- For billing work, also verify `/credits`, `/api/credits/quote`, `/api/credits/account`, `/api/credits/checkout`, `/api/capabilities/jobs`, and `/api/stripe/webhook` behavior where possible.
- If a dev server is running, do not assume its `.next` cache survived `next build`; restart after build if routes become inconsistent.

## Required Final Report

After meaningful completed work, also record the receipt through
`hii skill report`. Mark repeatable work with `--repeatable`; this creates a
draft only. Registration remains proof-backed and operator-reviewed.

Done:
Verified:
Not Verified:
Proof:
Risk:
Next Command:
