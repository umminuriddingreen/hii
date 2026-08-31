# HII User-Owned Network and Compounding Interaction Model

**Status:** Founder-level product and economic direction

**Date:** 2026-08-30

**Current release boundary:** This direction does not expand the founder beta
beyond the local intent → context → bounded work → verification → receipt loop.

## Thesis

HII is the human-owned orchestration layer for everyday intelligence.

The long-term product is a user-owned environment where a person's information,
preferences, agents, permissions, computation, relationships, creations, and
verified history can work together without becoming the property of a model
vendor, social platform, or relay.

HII should let people do everything **through** HII without forcing everything
to happen **inside** HII. Existing applications, websites, devices, agents, and
creative tools remain useful. HII supplies continuity, authority, provenance,
execution, verification, and portable memory around them.

The company-level promise is:

> Your life does not belong to HII. HII belongs to you.

## The compounding interaction loop

The founder interaction model is not repeated prompting. It is a continuous,
user-benefiting loop:

```text
human activity and expressed intent
→ scoped signals and source-linked information
→ evidence-backed objects, relationships, and possible intent
→ the smallest useful context for the current objective
→ human or agent action through explicit authority
→ useful output, verification, and receipt
→ correction, preference, project memory, and reusable capability
→ increasingly valuable future output for the same human
```

HII's advantage is the rate at which it can turn legitimate user activity into
useful, user-owned continuity. That must never become an excuse for ambient
surveillance or indiscriminate collection.

The governing formula is:

```text
high-velocity context processing
+ selective durable memory
+ explicit authority
+ provenance and correction
= compounding user value
```

Not:

```text
capture everything
→ retain everything
→ infer identity silently
→ optimize dependency and advertising
```

## High-velocity context without mass surveillance

HII may process cursor focus, selection, nearby objects, edits, speech, typed
language, application state, recent actions, and project objectives when the
user has enabled the relevant observation scope. Perception is evidence, not
permission.

Every signal belongs to one retention class:

1. **Private / excluded:** never observed or retained.
2. **Ephemeral attention:** used briefly to interpret the current interaction,
   then discarded.
3. **Event history:** a bounded record of a meaningful action, source, change,
   or decision.
4. **Durable object memory:** user-owned information worth resuming, relating,
   correcting, exporting, or acting on later.
5. **Verified capability:** repeated successful work promoted only after proof
   and explicit review.

Raw behavioral exhaust must not silently become permanent memory. Durable
memory should be semantic, minimal, source-linked, confidence-bearing,
correctable, deletable, and useful to a named objective.

Explicit statements and user corrections outrank inference. Inferred
preferences remain labeled and must not silently define taste, identity,
relationships, or public presentation.

## The social network is an object network

HII should distribute usable objects rather than flatten every contribution
into an attention post.

```text
Profile = an Identity and public Space projection
Post    = a published HII Object or collection
Feed    = an authorized projection of signed publication Events
Follow  = a revocable relationship between Identities, Spaces, or Objects
Share   = a signed and revocable Grant
Remix   = a provenance-linked fork
Message = a private permissioned object stream
Call    = a temporary real-time capability session
Sale    = an Offer, Grant, payment event, and Receipt around an Object
```

A published object may be an image, video, audio work, document, 3D model,
physical-item listing, source bundle, workflow, application, capability, agent,
or entire Space. Opening it in HII should preserve its useful type:

- a 3D model remains navigable;
- a workflow remains inspectable and executable within its grants;
- a video retains sources, transcript, chapters, and related objects;
- an agent application retains its declared capabilities and authority;
- a remix retains lineage to the original;
- a purchase retains license, entitlement, provenance, and receipt.

The feed is a view over canonical objects and events. It is never a second
content database. The default following feed should be chronological and
inspectable. Ranking, when offered, should be optional, explainable, and
controlled by the user rather than optimized for compulsive attention.

## Identity and account experience

The human-facing account can be simple:

1. Choose a public display name and unique handle.
2. Create a passkey using a platform authenticator or security key.
3. Set a short passcode that unlocks the encrypted local HII installation.
4. Generate an exportable recovery kit.
5. Enroll additional trusted devices explicitly.

The public name may change. The stable Identity and its cryptographic keys do
not. A passcode is a local unlock mechanism, not the sole Internet credential.
Devices sign their own authorized operations; relays cannot impersonate the
human, create grants, or author canonical state.

## Ownership, publication, and portability

Every shared object should preserve:

- stable object and owner identity;
- type, underlying data, content hash, and revisions;
- source, attribution, derivation, and rights context;
- storage location and published replicas;
- visibility: private, named identities, followers, unlisted, or public;
- permissions to view, download, invoke, remix, resell, or delegate;
- price, license, entitlement, and availability when relevant;
- agent and capability access boundaries;
- publication, moderation, transaction, and verification receipts.

Canonical state stays in the user's HII Space and signed operation history.
HII-managed services may cache public bytes, route opaque ciphertext, or host
an explicitly selected replica, but they do not become the author of user
state. Export must include objects, relations, operations, grants, source
metadata, and portable media references.

Public deletion cannot guarantee that no third party retained a copy. HII must
truthfully distinguish local deletion, grant revocation, network tombstones,
managed-cache removal, and uncontrollable external copies.

## Open protocols and replaceable infrastructure

HII should use established protocols as adapters rather than inventing new
cryptography or making another platform canonical:

- ActivityPub / ActivityStreams may project public actors, inboxes, outboxes,
  follows, likes, replies, and shares into the federated social web.
- WebAuthn passkeys authenticate accounts and trusted devices.
- An audited Messaging Layer Security implementation should protect private
  group messaging.
- WebRTC should carry voice, video, screen, and low-latency peer sessions with
  authenticated signaling and TURN fallback.
- glTF and other portable formats should be preferred for distributed 3D
  viewing while source formats and provenance remain available when licensed.

These are Network adapters over HII Object, Event, Identity, Grant, and Receipt
contracts. They do not replace those contracts.

## Communication

Messages are private object streams with explicit participants, device keys,
retention, attachment grants, and delivery state. Calls are temporary sessions,
not permanent microphone access. Starting a call, adding a participant,
sharing a screen, recording, transcribing, or giving an agent access are
separate visible authorities.

Peer-to-peer communication may be free when direct transport works. Hosted
TURN relay, media storage, transcription, moderation, and high-bandwidth video
delivery have real costs and require bounded allowances, user-provided
infrastructure, or transparent paid service.

## Commerce and aligned economics

HII should make money when humans, creators, providers, or organizations first
receive measurable value.

```text
person accomplishes something valuable
→ creator, provider, or computer is compensated
→ HII receives a transparent fee for enabling, governing, or verifying it
```

HII must not depend on selling attention, behavioral profiles, or access to
private user data.

The free personal foundation should include:

- identity and public profile;
- local user-owned data and export;
- local personal agent and project memory;
- local objects, grants, receipts, and chronological following feed;
- publishing free objects;
- direct peer-to-peer messaging and calls where infrastructure permits;
- provider choice and self-hosting.

Paid responsibility may include:

- managed encrypted sync, recovery, storage, delivery, and relays;
- scheduled or monitored automation;
- hosted intelligence, rendering, GPU work, and other computation;
- team governance, shared policy, and audit;
- creator and community services;
- transactions for digital objects, physical listings, capabilities, services,
  and applications;
- optional escrow, verification, support, and dispute handling.

The launch offer remains the free local beta plus the founder activation
defined in `LAUNCH_AND_MONETIZATION.md`. Future subscriptions, marketplace
fees, compute margins, and community pricing remain candidates until external
usage validates the responsibility HII is taking.

## North-star metric and guardrails

The long-term north-star metric is:

> **Weekly verified value flows per active human.**

A value flow may be a verified task, useful artifact, meaningful remix,
creator earning, successful exchange, resumed project, repeated workflow, or
correctly governed capability use.

Supporting metrics include:

- time to first useful object and first verified receipt;
- repeat verified workflows and successful resumption;
- creator earnings and buyer outcomes;
- provenance coverage and valid transaction receipts;
- user corrections and explicit preference control;
- successful export, self-hosting, and provider switching;
- value delivered relative to computation and infrastructure cost;
- fraud, abuse, unwanted action, data-loss, and authority incidents.

Do not optimize time in app, feed depth, notifications opened, personal data
collected, or difficulty leaving. HII should benefit when the user does
something valuable, not when the user becomes dependent.

## Moderation, safety, and real-world commerce

A public network requires safety infrastructure from its first external
publication: block, mute, report, rate limits, visibility controls, content
labels, copyright and impersonation handling, provenance checks, and an abuse
response process. Open source does not remove operator obligations for hosted
services.

Digital commerce should precede physical commerce. Physical-item listings add
shipping, fraud, returns, taxes, prohibited-goods enforcement, location risk,
identity verification, consumer protection, and jurisdiction-specific duties.
Feedback, interest, reservation, purchase, investment, and ownership are
different commitments and must never be collapsed into one action.

## Implementation sequence

The existing local object-to-artifact loop remains first. The Network grows in
verified slices:

### N1 — Profile, publish, follow, open

1. Create two passkey-backed identities with public handles.
2. Publish one existing image or 3D object with a signed visibility grant.
3. Follow the publisher from the second identity.
4. Receive the signed publication in a chronological feed.
5. Open the real object in the second user's canonical HII canvas.
6. Fork or remix it with lineage intact.
7. Revoke the grant, emit a tombstone, and export both accounts' state.

### N2 — Replies, groups, and private messages

Add replies, mentions, private object streams, device enrollment, group key
changes, attachment grants, block/mute/report, and bounded retention.

### N3 — Voice, video, and presence

Add authenticated signaling, WebRTC media, explicit device selection,
participant changes, screen-sharing grants, TURN fallback, and call receipts
without recording content by default.

### N4 — Digital objects and capabilities

Add offers, licenses, entitlements, creator payouts, refunds, disputes, and
receipt-backed delivery for digital artifacts, applications, workflows, and
compute.

### N5 — Physical listings and fulfillment

Add physical-item listings only after jurisdiction, safety, identity,
payments, fraud, shipping, returns, and moderation responsibilities are
explicit and verified.

## First acceptance gate

The direction is not implemented merely because HII already has a canvas,
identity foundations, a marketplace preview, or replication code. The first
social-network claim requires an end-to-end test across two real accounts and
two clients:

```text
create identity
→ publish user-owned object
→ follow
→ receive signed feed event
→ open typed object in recipient Space
→ preserve provenance through remix
→ revoke and export
```

The test must verify authentication, signatures, authorization, blob hashes,
offline/reconnect behavior, revocation, moderation controls, export, and the
absence of unauthorized private data in the relay or published object.

## Final principles

> HII distributes usable information and capability, not merely appearances.

> Write context at the speed of human work, but preserve only what serves the
> human with consent, provenance, correction, and control.

> HII only wins after the human, creator, or provider receives value.
