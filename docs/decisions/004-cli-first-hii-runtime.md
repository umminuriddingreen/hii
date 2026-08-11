# ADR 004: CLI-First HII Runtime

**Status:** Accepted  
**Date:** 2026-08-11

## Decision

HII is CLI-first for now.

The Rust CLI is the primary product surface, runtime owner, verification
surface, and agent contract. Everything needed to operate HII should be
reachable through the CLI before it is promoted into web, Tauri, Notch,
Browser, Create, or spatial workspace views.

AII is no longer a separate product, brand, app, repo, or planning track.
Useful code that currently lives under `aii/` is internal HII runtime code and
should be migrated behind CLI-owned modules, commands, receipts, and proof
contracts. The name may remain temporarily in paths only as migration debt.

## Why

The split between HII as a surface and AII as an agent/runtime layer created too
many things to track. It also made agents re-litigate product boundaries instead
of improving the loop that matters:

```text
intent -> context -> bounded work -> verification -> receipt -> reusable capability
```

The CLI is the narrowest place to make that loop reliable because it can own
state inspection, execution, proof, receipts, local models, provider handoffs,
and automation without requiring a polished visual surface first.

## Consequences

- New HII capabilities start as CLI commands or CLI-backed internal modules.
- Web and desktop views render or call CLI-owned state and contracts; they do
  not define new authority.
- The old `aii/workstation` app is not a forward product path. Mine it only for
  reusable implementation ideas, then archive or remove it when equivalent CLI
  commands exist.
- `aii/daemon/hiid.mjs`, `aii/skills`, `aii/capabilities`, `aii/admin-agent`,
  and `aii/model-runtime` should be treated as HII runtime migration targets.
- Do not create another daemon, workstation, registry, memory store, or agent
  control plane outside HII CLI ownership.

## Migration Order

1. Freeze product language around CLI-first HII and remove user-facing AII copy.
2. Inventory `aii/` modules by live dependency and runtime value.
3. Move useful runtime contracts behind `hii agent`, `hii caps`, `hii skills`,
   `hii proof`, `hii context`, and `hii work` commands.
4. Replace `aii/*` imports in scripts and server code with HII runtime module
   paths or CLI invocations.
5. Archive `aii/workstation` after its Apple-context and worktree ideas are
   either migrated or explicitly rejected.
6. Only then consider web/desktop cleanup.

## Verification Gate

A cleanup is not done until these pass:

```bash
npm run cli:check
bash cli/scripts/regression.sh
npm run hii:agent-home:check
npm run hii:launcher:check
```

For any change touching web projections, also run:

```bash
npm run check
npm run build
```
