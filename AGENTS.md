# HII Agent Guide

This repo is an active multi-agent worktree. Codex, Claude, HII workers, and the user may all be editing or generating artifacts at the same time.

## Worktree Discipline

- Check `git status --short` and targeted diffs before editing.
- Do not reset, delete, format, or rewrite files outside your scoped task.
- Treat broad untracked folders such as `.claude/`, `.hermes/`, screenshots, and `life/` as possibly owned by another agent or the user.
- Preserve the current product repo at `/Users/ummi/hii`; do not confuse it with `/Users/ummi/hii-old`.
- Keep secrets reference-only. Never print raw token values or copy credential files into docs, logs, or commits.

## Current Product Direction

- HII is a capability terminal and exchange spine.
- Production billing is moving toward: authenticated account balance, Stripe top-ups, quoted capability jobs, reserved credits, execution transcript, ledger rows, and proof artifacts.
- Local terminal execution remains operator-controlled and local-only until a hardened remote runner exists.
- Supabase tables in `public` must have explicit grants plus RLS policies.

## Verification

- Use `npm run build` for app validation.
- For billing work, also verify `/credits`, `/api/credits/quote`, `/api/credits/account`, `/api/credits/checkout`, `/api/capabilities/jobs`, and `/api/stripe/webhook` behavior where possible.
- If a dev server is running, do not assume its `.next` cache survived `next build`; restart after build if routes become inconsistent.
