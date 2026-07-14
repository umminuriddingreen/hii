# AII — agent coordination & capability layer

This directory is the AII layer of HII (see `docs/aii-hii-boundary.md` for the
full contract). AII owns agents-as-workers: lifecycle, coordination,
capabilities, and — eventually — configuration authority over HII's surfaces.

## Layout

- `daemon/hiid.mjs` — the local-first runtime supervisor (launchd agent
  `ai.hii.daemon`, plist versioned in `../launchd/`). State contract:
  `~/.hii/daemon/` (events.jsonl, actions.jsonl, instances.json, status.json).
- `capabilities/` — the capability registry (`registry.json`) and packs
  (`packs.json`). Source of truth; hiid publishes the registry to
  `~/.hii/capabilities.json`, which HII's thin client reads.
- `skills/` — the proof-backed skill growth contract. Agent actions become
  append-only receipts; repeatable work becomes a draft; only verified,
  operator-reviewed drafts enter the registered catalog.
- `admin-agent/` — admin workflow planning/policy logic (consent-gated
  proposals; no direct execution).
- `scripts/` — AII operational scripts (e.g. `hii-admin-agent-plan.mjs`).
- `workstation/` — the AII Agent Workstation, a Tauri control plane for
  coding agents (moved from `~/dev/aii-workstation`; a symlink remains there).

## Boundary rule

HII code (`app/`, `lib/`, `components/`) must never import from `aii/`.
The layers meet only at:

1. `~/.hii` state files — AII writes config/runtime state, HII reads and renders.
2. Process execution — HII surfaces may spawn `aii/daemon/hiid.mjs` as a
   subprocess (start/stop/status), never require() it.
3. HII's declared capability endpoints, which AII calls like any agent.
