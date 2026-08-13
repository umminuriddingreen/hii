# HII Agent Guide

## Required Product Context

Before planning or modifying HII, read:

- `docs/HII_AII_MASTER_CONTEXT.md`
- `docs/decisions/004-cli-first-hii-runtime.md`

These documents define the founder thesis, the CLI-first product direction,
current Context Dock product scope, architecture constraints, deferred roadmap,
trust model, and required agent behavior. Historical brainstorms do not
override the current product decision.

This repo is an active multi-agent worktree. Codex, Claude, HII workers, and the user may all be editing or generating artifacts at the same time.

## Mission

HII is a local-first control plane for verified agent work.

The current product wedge is:

Human intent -> bounded agent/tool work -> logs/proof -> verification -> receipt -> reusable capability.

## Worktree Discipline

- Start with `hii home --json`, the compact machine-readable map of the current
  repo, work queue, capabilities, guardrails, and likely next actions.
- Deepen only when needed with `hii context --json`, `hii work --json`,
  `hii caps show`, or `hii og status`. The shared cross-agent contract is
  always available at `hii agents guide`.
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
- HII is CLI-first for now. The Rust CLI is the primary product, control
  surface, runtime entrypoint, verification surface, and agent contract.
- Do not introduce or revive AII as a separate product, brand, app, repo,
  daemon family, or planning track. Existing `aii/` code is legacy/internal HII
  runtime code until it is migrated behind CLI-owned modules and commands.
- Web, Tauri, Notch, Browser, Create, and spatial workspace surfaces are
  projections over CLI-owned HII state. They should not become the source of
  truth until the CLI loop is boringly reliable.
- Founder decision ADR 001 reopens an Obsidian-class HII Knowledge Workspace
  built on Context Dock and `~/.hii/hii.db`.
- The current implementation target is an end-to-end local knowledge loop:
  Markdown notes, folders, links/backlinks, tags, FTS5 search, graph, daily
  notes, history, trash/restore, import/export, provenance, and receipts.
- Do not expand this into a plugin marketplace, cloud sync product, Creator
  Desk, credits expansion, or decentralized compute feature until the local
  knowledge loop is reliable.
- Local terminal execution remains operator-controlled and local-only until a hardened remote runner exists.

## CLI Interaction Surfaces

The Rust CLI lives in `cli/` but builds into the workspace target, so the binary
is `target/debug/hii` at the repo root, not `cli/target/debug/hii`.

- Anything that ends in "choose one of these" uses `cli/src/picker.rs`
  (`picker::select`) rather than printing a table the operator has to retype
  from. Ollama's shipped picker is the parity bar.
- Interactive widgets draw **inline**, never `EnterAlternateScreen`, so terminal
  scrollback stays the record of what happened. `cli/src/file_explorer.rs` is the
  deliberate exception.
- Move the cursor with relative `\x1b[{n}A` plus per-row `\r\x1b[2K`, never
  save/restore: saved coordinates break once drawing scrolls at the viewport
  bottom. `cli/src/keyboard.rs::redraw` is the reference.
- Pad plain strings to width *before* painting them. Escape bytes occupy no
  columns, so a width applied to an already-painted string misaligns.
- Gate every interactive path on `picker::is_available()` (`HII_UI_LINE_MODE`
  unset plus stdin/stdout both TTYs) and keep the printed fallback so piped and
  scripted use is unchanged.
- Interactive selection is still proof-bearing work: a model switch through the
  picker emits `conversation.model_changed` with its source, because a run that
  quietly changed models is a run whose proof record lies.
- Prove TUI behavior with unit tests over the rendered frame and the emitted
  escape sequences. Do not drive the CLI through a pty to "see" it; that burns
  minutes and tokens for a weaker result.

## Cost Discipline

Claude quota is the scarcest resource on this machine. Spend it on judgment,
synthesis, and code that ships.

- Cache aggressively: keep the conversation prefix stable, batch independent
  reads, and never re-read a file to verify an edit that already succeeded.
- Push bulk work down the stack in this order: shell/`rg`/`jq`, then a local
  model, then a background agent, then a foreground Claude turn. Anything over
  about a minute of tool time belongs to a background agent.
- Delegate bounded, independent work only. Synthesis, final validation,
  approvals, and every external action stay in the main thread.
- Orient with `hii home --brief` (~600 bytes) and escalate to `--json` (~7800)
  only when brief is genuinely not enough.

## Verification

- Use `hii health --text` and `hii caps show` as compatibility-safe agent
  entrypoints.
- For CLI work, run `cargo build` and `cargo test` from `cli/`.
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
