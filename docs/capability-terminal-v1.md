# HII Capability Terminal V1

V1 treats HII as a backend-owned capability system:

- The registry is declarative and lives at `lib/capabilities/registry.json`.
- The TypeScript contracts live at `lib/capabilities/types.ts`.
- Local terminal and managed Termite runs append `CapabilityJob` JSONL rows to
  `.hii/capability-jobs.jsonl`.
- Supabase, Stripe, and R2 remain the durable spine for authenticated file
  exchange and payment workflows.

The important boundary is execution ownership. A browser page, CLI command, or
LLM can request a capability, but the server checks the declared capability,
host protections, authentication state, budget, and whitelisted route before
anything runs.

## First Capability Path

1. `/api/capabilities` exposes backend-visible capability definitions.
2. `/terminal` renders capabilities and recent local capability jobs.
3. `hii caps` lists the same registry from the CLI.
4. `hii jobs` tails the local JSONL job store.
5. `/credits` quotes a selected capability with shared quote fields.
6. `/termite` creates `termite.rhino.managed_job` rows with logs, ledger rows,
   and initial proof artifacts.

This is not decentralized compute yet. It is the control spine needed before
outside resources can safely plug into HII.
