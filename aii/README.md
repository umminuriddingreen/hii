# AII — agent coordination & capability layer

This directory is the AII layer of HII (see `docs/aii-hii-boundary.md` for the
full contract). AII owns agents-as-workers: lifecycle, coordination,
capabilities, and — eventually — configuration authority over HII's surfaces.

## Layout

- `daemon/hiid.mjs` — the local-first runtime supervisor (launchd agent
  `ai.hii.daemon`, plist versioned in `../launchd/`). State contract:
  `~/.hii/daemon/` (events.jsonl, actions.jsonl, instances.json, status.json).
- `workstation/` — the AII Agent Workstation, a Tauri control plane for
  coding agents (moved from `~/dev/aii-workstation`; a symlink remains there).

## Boundary rule

HII code (`app/`, `lib/`, `components/`) must never import from `aii/`.
The layers meet only at:

1. `~/.hii` state files — AII writes config/runtime state, HII reads and renders.
2. Process execution — HII surfaces may spawn `aii/daemon/hiid.mjs` as a
   subprocess (start/stop/status), never require() it.
3. HII's declared capability endpoints, which AII calls like any agent.
