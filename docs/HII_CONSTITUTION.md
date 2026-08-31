# HII Constitution

**Status:** canonical product contract  
**Date:** 2026-08-27

HII consists of a model-and-tool-neutral Harness, a persistent user-owned
Space, and a permissioned Network connecting Spaces and objects. All three
operate through one local-first Object and Event protocol that preserves
authority, provenance, verification, portability, and user ownership.

## Product model

- **Harness** interprets intent and coordinates models, capabilities,
  approvals, execution, verification, receipts, and reusable workflows. AII is
  internal orchestration code, not a fourth product.
- **Space** is the offline-capable, user-owned shared state humans, models,
  tools, devices, and collaborators manipulate. The canvas is its primary
  view, not its database.
- **Network** connects only explicitly shared Spaces and objects. It replicates
  authorized state; it never owns everyone's context.
- **Runtime/Protocol** is the local source of truth for Object, Edge, Event,
  Identity, Grant, Capability, Run, and Receipt.

## Permanent loop

```text
capture or create objects
→ select or reference context
→ express intent
→ inspect proposed context and authority
→ execute bounded capabilities
→ show semantic progress
→ verify the actual result
→ produce objects and a receipt
→ remember, share, remix, export, or promote
```

The loop compounds for the user:

```text
scoped human activity
→ useful user-owned context
→ increasingly valuable verified outputs
→ corrections, preferences, memory, and reusable capability
→ better future context and action for the same human
```

HII may process interaction signals at high velocity, but raw behavioral
exhaust does not silently become permanent memory. Durable memory is selective,
source-linked, confidence-bearing, correctable, deletable, and useful to a
named human objective. Perception is evidence, never authority.

## Architecture laws

1. Harness writes through Runtime commands and capabilities, never directly to
   persistence.
2. Space renders Runtime projections and never becomes canonical state.
3. Network replicates authorized Objects, Events, Grants, and blobs; it is not
   the owner database.
4. Models interpret. Capabilities act. Models are never the system of record.
5. Every significant mutation emits a durable Event.
6. Every agent, tool, device, and service action has explicit bounded authority.
7. Every derived artifact retains its source and lineage.
8. Model completion is not verification.
9. CLI, canvas, browser, mobile, and future clients use the same Runtime contracts.
10. Private is the default; sharing is explicit, inspectable, and revocable.
11. Space remains useful offline and after a generating model disappears.
12. Users can export their Spaces and Objects in portable formats.
13. No feature creates an incompatible object store or execution system.
14. Features are object types, views, capabilities, Network services, or Runtime
    invariants—not new top-level products.
15. HII helps people do work through their existing tools; it does not require
    every activity to remain inside an HII-owned application.
16. Social feeds, profiles, messages, calls, listings, and marketplaces are
    projections or services over the same user-owned Objects, Events,
    Identities, Grants, and Receipts.
17. HII must not monetize surveillance, compulsive attention, or artificial
    lock-in. It earns from optional responsibility and value-bearing activity.

## Product character

- Intent-first, user-owned, local-first, calm, spatial, and consumer-facing.
- Deterministic software before model inference; local inference when useful,
  hosted inference only through a visible boundary.
- Context is minimal, source-linked, previewable, correctable, and deletable.
- Suggested, considered, approved, rejected, and superseded decisions remain
  distinguishable.
- Progress describes meaningful work rather than displaying generic waiting.
- Undo, rollback, restart recovery, verification, and receipts are product
  features, not backend details.
- Repeated verified work may become a draft capability, but never silently
  gains authority.
- Finished structured artifacts—not screenshots of chats—are the primary unit
  of sharing and distribution.

## Social and economic alignment

The long-term Network is an object network: a profile is an Identity/Space
projection, a post is a published Object, a feed is a view of signed
publication Events, a share is a Grant, a remix is a provenance-linked fork,
and a sale is an Offer plus entitlement and Receipt.

The personal foundation remains local-first, portable, provider-neutral, and
useful without payment. HII may charge when it takes an optional ongoing
responsibility—managed sync, relay, recovery, automation, compute, governance,
support, or commerce—or when it facilitates an exchange that creates value for
the participants first. Time in app, feed depth, and data collected are not
success metrics. The long-term north star is weekly verified value flows per
active human.

The complete founder direction, safety boundary, and staged acceptance gates
are defined in
[`HII_USER_OWNED_NETWORK.md`](HII_USER_OWNED_NETWORK.md).

## Feature rule

Every proposed feature must be registered in `HII_FEATURE_REGISTRY.yaml` with
one classification and one lifecycle state. An unclassified feature requires a
written architecture decision before implementation.
