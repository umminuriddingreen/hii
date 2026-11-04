# HII Cloud + HII Social — monetization and social rail plan

Status: product proposal; no billing products, prices, or social agent permissions are launched by this document.
Date: 2026-11-04
Owner: HII
Decision intent: keep personal/local computing free; offer paid managed backup/storage, and build opt-in human–agent social infrastructure without monetizing private data or attention.

## Thesis

HII should monetize infrastructure inconvenience, not user dependence. The cost that compounds over time is durable off-device storage and reliable recovery of memories, canvases, files, media, and version history. Raw text memories are comparatively small; images, videos, archives, and duplicate historical snapshots drive capacity. Never make local memory, local inference, local exports, peer interactions, or access to an owner's own data dependent on a subscription.

HII Social is the distribution and communication layer: people and their agents can exchange posts, images, project artifacts, Space invitations, and tightly scoped agent-to-agent requests. HII Cloud is the optional managed durability layer. The products may use the same account identity and asset-addressing primitives, but *private backup bytes must not become social content by default*.

## Principles — nonnegotiable

1. Local-first authority; user-readable local memory remains available offline and after cancellation.
2. Private cloud backups are encrypted on the client. The storage service must not receive plaintext or client decryption keys. Verify key custody and recovery end-to-end before marketing as zero-knowledge.
3. No advertising, behavioral targeting, sale of personal data, paid ranking, pay-to-reach, or engagement-based manipulation.
4. Unlimited local storage and local export. Support user-controlled backup destinations (e.g., S3-compatible or local drive) where practical. Hosted HII Cloud is optional.
5. Clear, predictable quotas based on *retained encrypted bytes*, not "AI memories," conversation count, agent count, or amount of knowledge.
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
- `package.json` includes Stripe SDK but not evidence of a complete managed-subscription billing/entitlement integration.
- Do not introduce an alternate persistent memory database for billing or for social posts.

## Product A — HII Cloud

### What customers buy

- Automatic encrypted incremental backup of approved HII content, scheduled snapshots, restore across devices, version retention, and an understandable storage dashboard.
- Selected asset categories: canonical memory objects, workspace state, knowledge, attachments, images, audio, and documents. Explicit inclusion for large media; exclude model weights, caches, inference scratch, and downloaded dependencies by default.
- Restore verification (hash/integrity, decrypt locally, compare revision), tested recovery, and export to a user-owned destination.
- Optional encrypted sharing of selected assets is separate from backups and needs explicit content-scoped grants.

### Proposed tiers for testing, not committed pricing

| Tier | Price | HII-hosted backup/storage quota | Included |
| --- | ---: | ---: | --- |
| Local | Free | Suggested 1 GiB trial/standing allowance, subject to economics | Unlimited local memory/storage, local backup/export, HII Social, bring-your-own storage target |
| Backup | $4/month | 50 GB | Automatic encrypted backup, restore and version retention |
| Archive | $9/month | 250 GB | Same guarantees, larger retained media/history |
| Studio | $25/month | 1 TB | Same guarantees, higher capacity for creative projects |

Avoid charging for "agent messages" or "AI memories." Use fixed plans initially rather than surprise per-GB overage. On quota exhaustion, block new remote backup writes with a clear explanation; do not block local work. Do not immediately erase data on cancellation. Offer a disclosed grace period, download/restore/export, then a disclosed retention/deletion process.

Prices are hypotheses. Validate actual retained GB/user, churn, snapshot frequency, upload counts, payment fees, support load, and restoration cost before launch.

### Illustrative unit economics (not actual HII margins)

Cloudflare R2 Standard lists $0.015/GB-month, no egress fee, and metered Class A/B operations (as of October 2026). At the full storage quota this implies storage rent alone of approximately: 50 GB = $0.75/month, 250 GB = $3.75/month, 1 TB = $15.00/month (decimal GB). These are *not* all-in costs: exclude operations, database, CPU, logs, security, payment fees, customer support, refunds, and tax.

Stripe lists 2.9% + $0.30 per successful US card charge, plus 0.7% of Billing volume under its pay-as-you-go Billing plan; actual fees depend on plan/payment method and should be modeled before release.

Sources:
- https://developers.cloudflare.com/r2/pricing/
- https://stripe.com/billing/pricing

### Technical boundary

```text
Canonical local HII records/files
    -> backup selection + incremental manifest + encrypted deduplicated chunks
    -> HII Cloud upload gateway [identity + entitlement + atomic quota reservation]
    -> private ciphertext R2 objects
    -> signed account manifest / encrypted revision metadata
    -> recovery client [retrieve + integrity check + decrypt locally + restore]
```

All encryption and key derivation occur on the client. Metadata exposure should be explicitly documented (account, retained-byte totals, timestamps, chunk sizes and counts may still be visible). Explore owner-managed recovery keys and per-device encrypted key wrapping; never silently escrow private keys.

### Billing / entitlement scope

- Stripe Checkout for signup, Customer Portal for plan/cancellation, verified idempotent webhooks.
- Add account subscription and entitlement tables to the public-site account DB. Suggested concepts: `billing_customers`, `billing_subscriptions`, `storage_entitlements`, `storage_usage_events`. Provider event IDs unique and webhook processing replay-safe.
- Apply new entitlement in `workers/public-site/src/library.rs` by replacing the hard-coded 1 GiB threshold with account-scoped server-authoritative quota. Preserve atomic reservation and concurrency safety during simultaneous uploads.
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

### Phase 0 — refine primitives and measure
- Instrument local storage composition (text vs media, unique bytes vs versions, backup candidate bytes) with on-device aggregate metrics; no private content telemetry by default.
- Verify existing ciphertext upload and restore contracts; assess crypto key custody/recovery and cross-device restore.
- Document pricing hypotheses and expected fully-loaded COGS. Test that local/bring-your-own backups work without paying HII.

### Phase 1 — Cloud reliability, before charging
- Snapshot manifest, incremental encrypted chunks, local encryption/decryption, retention and restore tests.
- Storage accounting, quota reservation concurrency test, account deletion/export, cancellation grace and lifecycle.
- Demonstrate recovery to a clean device without the original HII installation (using owner-supplied recovery credentials).

### Phase 2 — Billing launch
- Integrate Stripe Checkout + portal + signed idempotent webhooks + entitlement projection.
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

- Whether free managed backup starts with 1 GiB or is limited to a time-boxed trial.
- Key recovery model and cross-device transfer; independent security review.
- Paid tier amounts, retention duration, regional data residency, and consumer-facing subscription terms.
- Direct messaging architecture, moderation staffing, and eligibility for public social discovery.
- Whether AT Protocol interop is warranted before first-party social functionality reaches product-market fit.

**Implementation rule:** do not build a second memory system, do not give the billing service decryption rights, and do not let social sharing inherit private-memory read permission.
