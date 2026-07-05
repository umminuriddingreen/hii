# HII — capability terminal and exchange spine

HII is a local-first capability terminal with a resource exchange spine. The
first market proof is deliberately narrow: backend-owned capabilities are
visible in HII Terminal, callable through `hii`, priced through credits, and
represented as jobs with logs, ledger rows, and proof artifacts.

The next adoption loop is browser-first. Think Open WebUI's local/offline AI
control plane, but aimed at HII's operating logic: the browser captures useful
links, HII stores the stream locally, a downloader caches pages onto the
machine, and Ollama interprets the cache for an offline feed.

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
- `hii.browser.link_capture` captures pages from Chrome into the local link
  stream.
- `hii.downloader.offline_cache` downloads captured pages into `.hii/link-cache`
  for offline reading.
- `hii.ollama.link_interpreter` summarizes cached link text with local Ollama
  when available.
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
hii links status    # browser/offline feed coordinates
hii links cache     # cache captured links and summarize with Ollama
hii jobs            # recent durable + local capability jobs
hii ship            # typecheck and commit locally
hii ship --push     # explicit external push to origin
hii terminal        # local terminal coordinates
hii terminal --open # open /terminal
hii legacy ...      # old Python runtime at ~/hii-old
```

## App Surfaces

- `/feed` is the browser-captured link stream. It accepts manual saves, reads
  Chrome extension posts from `/api/links`, and shows offline cache/Ollama
  summary state.
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
- Chrome Manifest V3 extension for browser link capture
- Ollama for local link summaries (`HII_LINKS_OLLAMA_MODEL`, default
  `fast-local`)

## Browser Link Stream MVP

Start the local app:

```sh
npm run dev
```

Open `http://localhost:3000/feed`.

Load the Chrome extension:

```text
chrome://extensions
Developer mode -> Load unpacked -> /Users/ummi/hii/extensions/chrome-link-capture
```

Capture links from the popup or right-click context menu. The extension posts to
`http://localhost:3000/api/links` by default; change that in the extension
options if the app runs somewhere else.

Cache the feed for offline use:

```sh
npm run hii:links:cache
# or
node scripts/hii-cli.mjs links cache
```

The cache agent writes HTML, readable text, and cache receipts under
`.hii/link-cache*`. If Ollama is running, it summarizes pages with
`fast-local`; if not, the download still completes and the feed marks the
summary as unavailable.

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
node scripts/hii-cli.mjs links status
node scripts/hii-cli.mjs links cache
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
