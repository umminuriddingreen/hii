# HII Cloud + HII Social — monetization and social rail plan

Status: product proposal; no billing products, prices, or social agent permissions are launched by this document.
Date: 2026-11-04
Owner: HII
Decision intent: operate with no fixed infrastructure spend before customers pay; keep personal/local computing free; sell optional managed encrypted backup capacity at a defensible markup; maintain a free, opt-in human–agent social rail without monetizing private data or attention.

## Thesis

HII should monetize infrastructure inconvenience, not user dependence. The cost that compounds over time is durable off-device storage and reliable recovery of memories, canvases, files, media, and version history. Raw text memories are comparatively small; images, videos, archives, and duplicate historical snapshots drive capacity. Never make local memory, local inference, local exports, peer interactions, or access to an owner's own data dependent on a subscription.

HII Social is the distribution and communication layer: people and their agents can exchange posts, images, project artifacts, Space invitations, and tightly scoped agent-to-agent requests. HII Cloud is the optional managed durability layer. The products may use the same account identity and asset-addressing primitives, but *private backup bytes must not become social content by default*.

## Principles — nonnegotiable

1. Local-first authority; user-readable local memory remains available offline and after cancellation. No HII-hosted backup storage is included in the free tier: unlimited local memory, self-managed backups, and bring-your-own storage are free; operator-hosted bytes are provisioned only against a funded entitlement.
2. Private cloud backups are encrypted on the client. The storage service must not receive plaintext or client decryption keys. Verify key custody and recovery end-to-end before marketing as zero-knowledge.
3. No advertising, behavioral targeting, sale of personal data, paid ranking, pay-to-reach, or engagement-based manipulation.
4. Unlimited local storage and local export. Support user-controlled backup destinations (e.g., S3-compatible or local drive) where practical. Hosted HII Cloud is optional.
5. Clear, predictable quotas based on *retained encrypted bytes*, not "AI memories," conversation count, agent count, or amount of knowledge. Do not incur fixed cloud infrastructure commitments ahead of payment, but distinguish this design goal from an absolute guarantee of zero cash risk; disputes, billing timing, tax, abuse, and recovery can produce liabilities.
6. Social visibility is explicit per object (private, friends, followers, public, unlisted, local). Content visibility, location visibility, and online presence must be independently controlled. No location by default.
7. Agents act under bounded, revocable delegation. Being a friend or follower does not confer access to someone's private memory, files, tools, or compute.
8. Inbound external agent content is untrusted data. No message can silently become a tool instruction, new memory authority, or executable grant.
9. Explicit human approval for posting publicly, sharing private information, spending money, or delegating actions outside a pre-approved narrow policy.
10. Export, deletion, blocking/reporting, transparent retention policies, and moderation are first-class product capabilities; account recovery and safety do not depend on monetization.

## Repository alignment (audited 2026-11-04)

- `workers/public-site/src/library.rs`: account-scoped opaque ciphertext chunks, manifests, integrity checks, R2 persistence, account-wide hard-coded 1 GiB quota.
- `workers/public-site/migrations/0012_account_library.sql`: account library manifest/chunk metadata.
- `workers/public-site/src/social.rs`, `0011_simple_social.sql`: signed-in profiles, followers/following, account follows. Not an agent social protocol or full posts/feed system.
- `lib/spaces/types.ts`, `policy.ts`, `protocol.ts`, `host/`: owned Spaces with invite, publication, read/write, upload and quota policy, bounded events. Retain owner authority.
- `fabric/identity/`: identity and scoped grants foundation, requiring production-grade WebAuthn integration.
- `fabric/relay/`: explicitly non-authoritative ciphertext mailbox/rendezvous foundation; no production listener or complete encrypted social messaging.
- `lib/server/hii-memory-workspace.ts` and core memory: typed memory objects, provenance, versions, local-first state.
- `package.json` includes Stripe SDK but not evidence of a complete managed-subscription billing/entitlement integration. Existing Cloudflare R2 bucket coupling in `workers/public-site/src/library.rs` requires a storage adapter to use Backblaze B2; do not pretend it is already swappable.
- Do not introduce an alternate persistent memory database for billing or for social posts.

## Product A — HII Cloud

### What customers buy

- Automatic encrypted incremental backup of approved HII content, scheduled snapshots, restore across devices, version retention, and an understandable storage dashboard.
- Selected asset categories: canonical memory objects, workspace state, knowledge, attachments, images, audio, and documents. Explicit inclusion for large media; exclude model weights, caches, inference scratch, and downloaded dependencies by default.
- Restore verification (hash/integrity, decrypt locally, compare revision), tested recovery, and export to a user-owned destination.
- Optional encrypted sharing of selected assets is separate from backups and needs explicit content-scoped grants.

### Proposed tiers — revised for zero fixed cloud commitment, not final prices

HII Local: **$0 forever, 0 GB of HII-hosted backup**. No upsell needed to use memory, agents, on-device compute, local export, local self-backup, or a user-owned storage destination. Do not silently give every account an HII-hosted storage quota; unmonetized accounts multiply cost and abuse exposure.

Hypothetical US monthly HII-hosted backup subscriptions for testing, *before taxes and any extra fees*:

| Tier | Monthly price | HII-hosted encrypted capacity | What customer buys |
| --- | ---: | ---: | --- |
| Local / Bring Your Own Storage | $0 | 0 GB | Unlimited device-local use and manual/self-managed backup |
| HII Backup | $1.79 | 100 GB | Managed encrypted incremental backup and recovery |
| HII Archive | $3.99 | 250 GB | Same product with room for media and history |
| HII Creator | $6.99 | 500 GB | Same product with more creative asset capacity |

Do not launch a 1–5 TB Google-matching plan on commodity per-GB storage economics without verifying margins at *full utilization*. HII's lower monthly price is not a claim to provide the same storage allowance or Google Gemini features. The differentiation is client-encrypted project/memory backup, independence of the model/provider, local inference, and private recovery.

No surprise overage or autonomous upgrades. When hosted quota is exhausted, pause *new backup uploads* (not on-device work). Keep a clear paid grace period, export and recovery options, and a disclosed storage-deletion timetable if a subscription ends or fails. Existing backup bytes still incur cost after cancellation until safely expired.

### Competitive benchmark and unit economics (verified 2026-11-04)

Google One (US): Basic **100 GB $1.99/mo**, Google AI Plus **2 TB $9.99/mo**, Google AI Pro **5 TB $19.99/mo**. These bundles include other Google services and, for AI tiers, Gemini features; HII cannot promise equivalent hosted inference or equivalent $/GB. Official: https://one.google.com/about/plans?hl=en_US

Storage options:
- Backblaze B2 pay-as-you-go starts **$6.95/TB-month**, first **10 GB free**, most API transactions free, first 3x average storage in monthly egress included; additional egress can incur fees. Use an S3-compatible provider adapter and verify actual pricing, transfer route, and API limitations. https://www.backblaze.com/cloud-storage/pricing
- Cloudflare R2 Standard is **$0.015/GB-month** plus operations, with 10 GB/month and specified operations included in its free tier. At a fully utilized 2 TB, storage alone can cost ~$30/month, exceeding Google's $9.99/2 TB bundle. The current implementation already uses R2, but its price makes large cheap plans unattractive. https://developers.cloudflare.com/r2/pricing/
- Stripe US domestic card payments **2.9% + $0.30** per successful transaction with no fixed standard setup/monthly fee. Stripe Billing pay-as-you-go is **an additional 0.7% of billing volume**, subject to the selected product and fee terms. https://stripe.com/pricing and https://stripe.com/billing/pricing

Illustrative *maximum-capacity* economics using $6.95/TB-month B2, 1 TB = 1000 GB, and the indicated card + Billing fees:

| Plan | Revenue | Storage | Card + Billing fees | Remainder *before* infrastructure, egress overage, customer support, taxes, disputes and refunds |
| --- | ---: | ---: | ---: | ---: |
| 100 GB | $1.79 | $0.70 | ~$0.36 | ~$0.73 |
| 250 GB | $3.99 | $1.74 | ~$0.44 | ~$1.81 |
| 500 GB | $6.99 | $3.48 | ~$0.55 | ~$2.96 |

These are *not* verified gross margins. At very low prices, the fixed $0.30 card fee and support risk matter. Charge for the quota via a fixed monthly plan; avoid an apparent discount that relies on most users never filling their purchased quota. Use cumulative retained bytes, not logical deduplicated objects, to meter only what the provider actually stores, with consistent encrypted chunk reuse.

### Zero-fixed-cost operating design

1. **Free product never provisions paid cloud capacity.** The social rail uses existing free-tier infrastructure or direct user-owned connectivity, with hard abuse/rate limits; as free traffic grows it can create costs and must be budgeted separately.
2. **Payment first:** collect a successful, confirmed payment and verify the provider webhook *before* enabling any paid HII-hosted upload entitlement. A checkout redirect or unsigned client flag never grants bytes. Prefer hosted checkout + provider portal, not a self-hosted payment stack.
3. **Provision on demand:** one metered object-storage account/bucket and per-account object prefixes; create/commit encrypted chunks only after entitlement. Avoid per-account infrastructure with fixed minimum fees.
4. **Storage provider abstraction:** retain the existing R2 gateway as an adapter; implement B2 S3-compatible adapter and compare real data-plane operations/cost. Do not migrate user data without verifying hash, manifest, restoration, and encryption compatibility.
5. **Spending safety:** per-account hard byte ceilings, concurrent quota reservations, global free-tier and operational caps, upload size/count/rate limits, budget alerts, abuse detection without reading private content, and cleanup of uncommitted multipart uploads.
6. **Finance timing:** storage is billed after use; Stripe payouts can be delayed, payments disputed/refunded, and tax/support/security costs can arise. Therefore zero *fixed baseline spend* is a launch constraint, not a promise of mathematically zero upfront cash exposure or zero downside.
7. **Cancellation:** stop new hosted writes after the stated grace period, retain data only for the clearly announced window, permit restores/exports while entitled, and delete as policy requires. Users must always retain local storage access. If payment is reversed, do not erase backups instantaneously.
8. **Cloud feature scope:** do not bundle unlimited cloud inference or expensive Gemini-equivalent hosted capabilities with $1–7 backup subscriptions. Model inference runs on the user's hardware or separately chosen provider; HII's native retrieval and agent interfaces are free.

### Technical boundary

```text
Canonical local HII records/files
  -> backup selection + incremental signed manifest + client-side encrypted chunks
  -> HII Cloud gateway [authenticated owner + paid entitlement + atomic quota reservation]
  -> storage adapter [R2 existing / B2 candidate; meter actual retained ciphertext]
  -> private provider-managed ciphertext objects
  -> account manifests and authenticated revision history
  -> verified restore [fetch + hash + decrypt locally + restore canonical records]

Free users -> local disk or their own backup provider; no HII-hosted private bytes.
```

All encryption and key derivation occur on the client. Metadata exposure should be explicitly documented (account, retained-byte totals, timestamps, chunk sizes and counts may still be visible). Explore owner-managed recovery keys and per-device encrypted key wrapping; never silently escrow private keys.

### Billing / entitlement scope

- Stripe Checkout for signup, Customer Portal for plan/cancellation, verified idempotent webhooks.
- Add account subscription and entitlement tables to the public-site account DB. Suggested concepts: `billing_customers`, `billing_subscriptions`, `storage_entitlements`, `storage_usage_events`. Provider event IDs unique and webhook processing replay-safe.
- Apply new entitlement in `workers/public-site/src/library.rs` by replacing the hard-coded 1 GiB threshold with account-scoped server-authoritative quota. Free accounts have zero hosted bytes. Preserve atomic reservation and concurrency safety during simultaneous uploads.
- Storage usage = retained encrypted chunk bytes plus reserved in-flight chunks; manifest retention, stale uploads, and GC must be included in consistency and billing logic. Billing provider *never* authorizes reading private backup bytes.
- No upload authorization based solely on client-reported plan or quota. Payment failure changes only hosted upload/retention policy, never local memory availability.
- Tests: signed webhook, duplicate/reordered events, payment delayed/failed, upgrade/downgrade, concurrent quota reservation, GC accounting, cross-account isolation, restore of historical revisions, cancel-and-export, missing recovery key, access revocation.

## Product B — HII Social: human + agent rail

### Product behavior

One identity with distinct *human profile*, *agent profiles* (clearly labeled and owned by a human), and *Spaces*. A user can post/share an image or artifact directly from a Space or editor, message a friend, invite a collaborator, or grant an agent a bounded request to coordinate with another person's agent.

Core events/objects: `human_profile`, `agent_profile`, `follow`, `friend_connection`, `post`, `asset_reference`, `space_invite`, `message_envelope`, `agent_request`, `capability_grant`, `delivery_receipt`, `moderation_event`. Treat these as a *social projection* or protocol surface, not an automatic promotion of private memory to public objects.

Four social interaction modes:
1. Human -> human: follow, chat, share image and posts, invite to a Space.
2. Human -> agent: ask a delegated agent to prepare/post something, summarize the user's shared context, or coordinate with another actor.
3. Agent -> human: identifiable, rate-limited messages and suggestions subject to recipient preferences.
4. Agent -> agent: consented exchange of typed requests, previews, bounded results, and receipts, not transfer of ambient authority.

### Agent-to-agent trust boundary

- Agent identity has owner account, key/device binding, visible label, declared capabilities, per-contact scopes, expiry, revocation, quotas, and optional human approval.
- Inbound agent requests are non-executable previews by default. The recipient can accept within constrained scope; the requesting agent never gets the recipient's private tools, keys, history, address, or unrestricted memory.
- Message envelopes signed, replay-resistant, auditable, with idempotency keys, max payloads, and recipient consent.
- Private chats and private group exchanges use independently encrypted content with explicit participants. For public posts, signatures establish attribution, not confidentiality.
- Anti-abuse: blocking, reporting, anti-spam limits, agent labeling, consent-based discovery, moderation, and age-appropriate defaults. No unsolicited unrestricted agent conversations.
- Continuous agent-to-agent loops require budgets and stop conditions, even if each message is individually authorized.

### Transport/interoperability

- Begin with HII-owned social graph and HII Space sharing; implement first-party authenticated messaging through a bounded gateway with a durable encrypted mailbox.
- Build on `fabric/relay` for private coordination when an authenticated transport adapter exists. Keep device/owner authority local. WebRTC/P2P can optimize transfer but is not mandatory for the first version.
- Use A2A for *structured cross-vendor agent tasks* if interoperability is needed; do not confuse A2A with a social feed, human identity, or permission grants.
- Evaluate AT Protocol for *public* posts, identities, records, and external federation later. AT Protocol repos are publicly readable and must not be a private-memory backup or a private encrypted inbox.
- Keep social API events interoperable through a versioned schema and signed actor identity where possible.

References:
- https://a2a-protocol.org/v1.0.0/
- https://atproto.com/specs/repository
- https://atproto.com/specs/blob

## Product experience / data boundaries

```text
HII on device
  ├─ Private Memory + Workspace (canonical, local)
  │    └─ opt-in encrypted backup -> HII Cloud [paid capacity]
  └─ Share composer -> audience + payload preview + per-object grants
       └─ HII Social Rail [free baseline]
            ├─ people, friends, follows, posts, Space invites
            ├─ clearly labeled delegated agents
            └─ signed messages / private encrypted delivery

Backup retention policy != social post retention policy.
Backing up content != publishing content.
Following a person != authorizing their agent.
```

Keep feed, canvas, chat, and CLI coherent without forcing all content into a feed. Sharing from native HII should be one explicit action, with scope, audience, receipt, and reversibility.

## Execution sequence

### Phase 0 — no fixed spend; refine primitives and measure
- Instrument local storage composition (text vs media, unique bytes vs versions, backup candidate bytes) with on-device aggregate metrics; no private content telemetry by default.
- Verify existing ciphertext upload and restore contracts; assess crypto key custody/recovery and cross-device restore.
- Document pricing hypotheses and expected fully-loaded COGS. Test that local/bring-your-own backups work without paying HII. Remove free account cloud upload entitlement and demonstrate a zero-hosted-bytes path. Compare B2 and R2 with real restore and egress load before choosing.

### Phase 1 — Cloud reliability, before charging
- Snapshot manifest, incremental encrypted chunks, local encryption/decryption, retention and restore tests.
- Storage accounting, quota reservation concurrency test, account deletion/export, cancellation grace and lifecycle.
- Demonstrate recovery to a clean device without the original HII installation (using owner-supplied recovery credentials).

### Phase 2 — Billing launch
- Integrate Stripe Checkout + portal + signed idempotent webhooks + entitlement projection. Issue storage quota only on verified, settled subscription payment, not on checkout redirect.
- Replace 1 GiB hard-coded quota with a versioned per-account entitlement.
- Offer paid tiers only after E2E restore and billing-failure tests pass.
- Display encrypted bytes stored, available quota, last verified backup, and next billing date.

### Phase 3 — Human social MVP
- Signed-in profile and follower experience; direct post/image sharing from a Space; per-item audience; invite and private message.
- Block/report and account/content lifecycle before public discovery.

### Phase 4 — Consented agent social MVP
- Create agent profile delegated to owner, scoped request envelope, inbox approval, capped outbound and inbound traffic, signed audit receipt.
- Demo: A's agent requests B's agent to exchange a selected image collection; B explicitly approves a bounded read of one collection, replies with an asset reference, and both owners see the receipts. Neither agent accesses the other's full library.

### Phase 5 — federation and larger storage
- Federate public feeds only if it improves distribution; keep encrypted private messaging separate.
- Evaluate A2A adapters and self-hosted relay/backup options.
- Reprice/add storage tiers using real usage and margin data; avoid speculative infrastructure overbuild.

## Launch gates / measures

- Backup integrity: clean-device restore success >= 99.9% in a repeatable test suite before selling "reliable backup"; record limitations.
- Security: no cross-account blob reads, no plan-forgery or webhook replay, no unauthorized agent execution/shares in adversarial integration tests.
- Business: retained GB per active paid account, storage gross margin after fees, upgrade conversion, cancellation reasons, support cost, and recovery success.
- Social: successful friend-to-friend asset delivery and consented agent-to-agent task completion; block/report latency and authorization denials, not maximizing time spent or engagement.
- Product: no paid dependency for local-first usage, no social auto-publication, no hidden location/presence publication, clean owner-controlled export.

## Open decisions (not blockers to documentation)

- Free managed HII-hosted backup is **not** part of the launch plan; decide only whether a later subsidized trial makes economic sense.
- Key recovery model and cross-device transfer; independent security review.
- Confirm actual paid tier pricing/capacity, provider economics, retention, regional data residency, and consumer-facing subscription terms. Zero fixed infrastructure cost does not eliminate chargeback, liquidity, tax, and abuse risks.
- Direct messaging architecture, moderation staffing, and eligibility for public social discovery.
- Whether AT Protocol interop is warranted before first-party social functionality reaches product-market fit.

**Implementation rule:** do not build a second memory system, do not give the billing service decryption rights, and do not let social sharing inherit private-memory read permission. The first billing milestone is a no-hosted-storage free account plus payment-gated hard quotas, not additional free cloud capacity.
