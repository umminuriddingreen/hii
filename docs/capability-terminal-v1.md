# HII Capability Terminal V1

V1 treats HII as a backend-owned capability system and local CI/CD control
surface:

- The registry is declarative and lives at `lib/capabilities/registry.json`.
- The TypeScript contracts live at `lib/capabilities/types.ts`.
- Local terminal and managed HII Rhino runs can append `CapabilityJob` JSONL rows
  to `.hii/capability-jobs.jsonl` for operator work.
- Production billing runs store account balance, reservations, jobs, transcript
  events, ledger rows, and proof artifacts in Supabase.
- Supabase, Stripe, and R2 remain the durable spine for authenticated file
  exchange and payment workflows.

The important boundary is execution ownership. A browser page, CLI command, or
LLM can request a capability, but the server checks the declared capability,
host protections, authentication state, budget, and whitelisted route before
anything runs.

## First Capability Path

1. `/api/capabilities` exposes backend-visible capability definitions.
2. `/console` renders capabilities and recent local capability jobs.
3. `hii caps` lists the same registry from the CLI.
4. `hii jobs` tails the local JSONL job store.
5. `/credits` quotes a selected capability with shared quote fields.
6. `hii rhino` creates `hii.rhino.managed_job` rows with logs, ledger rows,
   and initial proof artifacts.

This is not decentralized compute yet. It is the control spine needed before
outside resources can safely plug into HII.

## Multi-Agent Operating Model

HII work happens inside a shared workstation. Assume Codex, Claude, HII workers,
and the user may all touch the repo or runtime state.

- Treat `git status --short` and focused diffs as the first CI signal before
  editing.
- Keep CI/CD local-first: `hii status`, `hii caps`, `hii jobs`, `hii build`, and
  `npm run build` are the operating loop for now.
- Production job state is Supabase-backed; local execution state remains
  operator-controlled until a hardened runner exists.
- A capability is only shippable when it has a registry entry, a route or CLI
  surface, a job/ledger/proof model, and a verification command.

## Billing Path

The production credit loop is:

1. User signs in through Supabase Auth.
2. `/api/credits/checkout` creates a Stripe Checkout top-up.
3. `/api/stripe/webhook` applies the top-up idempotently to `credit_accounts`.
4. `/api/credits/quote` estimates the capability job.
5. `/api/capabilities/jobs` reserves balance and creates a durable job.
6. `/api/capabilities/jobs/[id]/finalize` converts reserved balance into
   compute reimbursement, HII fee, proof, and released unused reserve.
