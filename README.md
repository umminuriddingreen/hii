# HII — capability terminal and exchange spine

HII is a local-first capability terminal with a resource exchange spine. The
first market proof is deliberately narrow: backend-owned capabilities are
visible in HII Terminal, callable through `hii`, priced through credits, and
represented as jobs with logs, ledger rows, and proof artifacts.

The original file-for-value loop still exists. It is now modeled as the
`hii.exchange.asset_link` capability:

auth -> upload (server action -> Cloudflare R2) -> exchange link `/x/[id]` ->
Stripe Checkout (`/api/checkout`) -> webhook marks order paid
(`/api/stripe/webhook`) -> download re-verifies payment live with Stripe and
mints a 5-minute presigned R2 URL (`/api/download`), logging each download.

## Backend Capability System

Capabilities live in `lib/capabilities/` and are backend primitives, not UI
prompts. A capability declares its id, owner, runtime, inputs, outputs,
permissions, visibility, cost model, evidence, status, and trust level.

Current first-party capabilities:

- `hii.terminal.observe` watches the local terminal/process stream.
- `hii.agent.spawn` launches bounded local agent sessions from whitelisted
  presets.
- `hii.registry.scan` and `hii.registry.doctor` inspect local machine capability
  metadata without copying raw secrets.
- `hii.credits.quote` prices bounded capability jobs before execution.
- `termite.rhino.managed_job` is the canonical v1 proof path: quote/reserve a
  Rhino/Termite runner job, stream logs, write ledger rows, and return proof
  artifacts.
- `termite.rhino.installer_action` exposes the Termite alpha installer surface.
- `hii.exchange.asset_link` preserves the Supabase/R2/Stripe exchange loop.

Execution remains server-owned. UI and LLMs can discover and configure
capabilities, but only whitelisted backend routes and CLI commands decide what
runs.

## Local Jobs, Quotes, Ledger, And Proof

Shared contracts are in `lib/capabilities/types.ts`:

- `CapabilityJob`
- `CapabilityQuote`
- `LedgerEntry`
- `ProofArtifact`

V1 persistence is split by trust boundary. Local-only terminal receipts append
JSONL rows under `.hii/`; quoted capability jobs use Supabase tables for
`capability_jobs`, `credit_ledger_entries`, `task_transcript_events`, and
`proof_artifacts`. `node scripts/hii-cli.mjs jobs`, `/terminal`, and `/termite`
read that same job contract when Supabase is configured, with local JSONL as a
fallback.

## CLI Doorway

`scripts/hii-cli.mjs` is the local doorway:

```sh
hii                 # doorway help
hii context --json  # machine-readable context for agents
hii status          # machine/git/env snapshot
hii doctor          # status + registry doctor
hii caps show       # backend capability registry
hii og status       # ranked operational graph next path
hii og capture ...  # append an operational graph event
hii jobs            # recent durable + local capability jobs
hii ship            # typecheck and commit locally
hii ship --push     # explicit external push to origin
hii terminal        # local terminal coordinates
hii terminal --open # open /terminal
hii legacy ...      # old Python runtime at ~/hii-old
```

## App Surfaces

- `/terminal` is the local console for process snapshots, backend capability
  discovery, recent capability jobs, ledger/proof counts, and bounded agent
  spawn presets.
- `/credits` quotes capability jobs and produces ledger-ready transcript rows.
- `/termite` is the first concrete managed capability: quoted Rhino/Termite
  jobs with runner logs, ledger rows, and proof artifacts.
- `/upload` and `/x/[id]` remain the exchange asset flow.

## Stack

- Next.js 14 (App Router) + Tailwind
- Supabase — Postgres, Auth (SSR sessions via `middleware.ts`), RLS
  deny-by-default with per-seller policies (`supabase/schema.sql`)
- Cloudflare R2 for file storage (S3 SDK, presigned GETs)
- Stripe Checkout + signature-verified webhook
- Local JSONL for terminal and Termite alpha job receipts

## Run

```sh
npm install
cp .env.example .env   # fill: Supabase x3, R2 x4, Stripe x2, base URL
npm run dev
```

Stripe webhook locally:

```sh
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

## Verification

```sh
npm run build
npm run hii:registry:doctor
node scripts/hii-cli.mjs status
node scripts/hii-cli.mjs doctor
node scripts/hii-cli.mjs caps show
node scripts/hii-cli.mjs jobs
```

Canonical vertical-slice smoke path:

```sh
node scripts/hii-cli.mjs caps show
# Sign in locally, open /termite, choose a paid runner budget, and launch a job.
node scripts/hii-cli.mjs jobs
```

## Ship Checklist

- [ ] Hosting target (Vercel is the zero-config fit for this stack) + custom
      domain
- [ ] Stripe live keys + live webhook endpoint
- [ ] Direct-to-R2 presigned uploads (server-action upload caps file size at
      the host body limit)
- [ ] Receipt email with re-download link after purchase (Resend)
- [ ] Basic tests around checkout/webhook/download/capability jobs
