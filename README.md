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
- `termite.rhino.managed_job` queues managed Rhino/Termite alpha work.
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

V1 persistence is intentionally simple. Local-only terminal and Termite alpha
runs append JSONL rows under `.hii/`; authenticated exchange and payment flows
continue to use Supabase, R2, and Stripe as the durable product database.

## CLI Doorway

`scripts/hii-cli.mjs` is the local doorway:

```sh
hii                 # doorway help
hii status          # machine/git/env snapshot
hii doctor          # status + registry doctor
hii caps            # backend capability registry
hii jobs            # recent local capability jobs
hii terminal        # local terminal coordinates
hii terminal --open # open /terminal
hii legacy ...      # old Python runtime at ~/hii-old
```

## App Surfaces

- `/terminal` is the local console for process snapshots, backend capability
  discovery, recent local jobs, and bounded agent spawn presets.
- `/credits` quotes capability jobs and produces ledger-ready transcript rows.
- `/termite` is the first concrete managed capability: Rhino/Termite jobs with
  logs and proof hooks.
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
node scripts/hii-cli.mjs caps
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
