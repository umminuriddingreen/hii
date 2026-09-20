# HII Business Structure

Status: working operating map

Date: 2026-09-08
Scope: organize HII as a business without replacing the product thesis, ADRs, or launch plan.

## The Clean Shape

HII should be organized as one company with three layers:

```text
HII Studio      sells hands-on outcomes now
HII Product     turns repeated outcomes into software
HII Network     scales object exchange, teams, and services later
```

The spine is the same across all three layers:

```text
intent -> approved context -> bounded work -> artifact -> verification -> receipt -> reusable capability
```

If a feature, service, or campaign does not strengthen that loop, it is not a
current business priority.

## Layer 1: HII Studio

HII Studio is the near-term business. It sells founder-led implementation and
activation, not access to a giant unfinished platform.

Primary offer:

> Bring one valuable task. We configure HII around it and stay until the first
> verified result works.

Launch price: $500 one-time founder activation.

Best first customers:

- Mac-based creators, designers, researchers, founders, students, and operators.
- Already using ChatGPT, Claude, Codex, or local models.
- Have work scattered across folders, notes, repos, browser tabs, and chats.
- Can name one useful outcome worth at least $500 if finished correctly.
- Will inspect the result, proof, and receipt.

Studio deliverables:

- one scoped workflow diagnosis;
- HII setup around the customer's real task;
- one finished artifact or operational improvement;
- one inspectable receipt;
- seven days of fixes for the agreed workflow.

Studio must not create private one-off backends. If a client needs something
repeatable, build it as an HII capability or workspace object.

## Layer 2: HII Product

HII Product is the software that remains after studio work repeats.

Current product:

> A local-first, user-owned workspace that turns source-linked context into
> verified agent work.

The product has three internal product lines:

| Product line | Customer words | Business job | Current boundary |
| --- | --- | --- | --- |
| HII Workspace | visual workspace for thinking, making, and working with AI | self-serve activation and retention | desktop/local first; web projection exists but is not the whole product |
| HII Harness | context, authority, execution, verification, receipts | trust layer for agent work | CLI/runtime owns proof; humans should not have to think like the CLI |
| HII Capabilities | repeated verified workflows | converts services into repeatable software | promote only after multiple proven receipts |

The first product metric is not signup. It is:

> time from opening HII to first verified receipt.

Product readiness gates:

- first receipt in under 30 minutes for a guided user;
- a second receipt within seven days;
- no critical installer, permission, secret, or data-loss failure;
- repeated workflows can be replayed or promoted without rebuilding context.

## Layer 3: HII Network

HII Network is the long-term platform. It should stay subordinate to Studio and
Product until first-use and repeat-use evidence exist.

Network services include:

- identity and device pairing;
- shared Spaces and live object references;
- publishing, remixing, licensing, and exchange;
- team workspaces and business objects;
- messaging, calls, relays, hosted media, and commerce.

The Network promise:

> HII helps people exchange useful objects, capabilities, and services without
> giving away ownership of their context.

Do not sell the Network before the local product proves repeat value. Treat it
as architecture and economic direction, not current traction.

## Offer Ladder

| Offer | Price | Sell when | Proof required |
| --- | ---: | --- | --- |
| Local beta | free | immediately, but honestly | install or guided demo produces a real receipt |
| Founder activation | $500 one-time | now | one customer task, bounded workflow, verified receipt |
| Workflow pack | $250-$1,500 | after the same workflow repeats | two or more successful receipts in similar contexts |
| HII Pro | about $39/month | after repeat weekly use | 10 beta users, 2 receipts in separate weeks, 5 requests for an ongoing responsibility |
| Team implementation | $2,500-$10,000 | after cross-user repetition | 3 workflows repeated across users with stable permissions |
| Network transaction/service fees | TBD | later | actual exchange, relay, hosting, commerce, or compute cost/value |

Subscriptions should fund a real responsibility: signed updates, sync/recovery,
scheduled automation, encrypted backup/export, hosted relay/media, team
governance, or support. Do not charge just to remove artificial limits.

## Business Workspaces

For early business clients, the best structure is service-led:

```text
client account
  -> account-owned business workspace
  -> HII Studio admin grant
  -> customer-facing surface
  -> owner-facing HII surface
  -> receipts for consequential work
```

Good first business workspace categories:

- portfolio or launch site with ongoing content updates;
- storefront or paid download flow;
- campaign surface with assets, posts, and performance notes;
- inventory or operations tracker;
- research-to-report workflow;
- architecture/design project space with sources, drawings, and outputs.

Each business workspace should have:

- owner;
- audience;
- offer;
- canonical objects;
- allowed capabilities;
- approval gates;
- live surface;
- proof ledger.

## What To Stop Mixing

HII currently has several true ideas that should not share the same lane.

| Thing | Business lane | Do not confuse it with |
| --- | --- | --- |
| Spatial canvas | product experience | the whole business model |
| CLI/runtime | trust infrastructure | customer-facing pitch |
| Receipts | activation proof | marketing decoration |
| HII Drive | product capability | company strategy |
| Rhino/CAD adapters | vertical capability | first universal wedge |
| Exchange routes | Network/service line | proof that marketplace demand exists |
| QR cards and campus loops | channel experiments | product validation by themselves |
| Public website | acquisition surface | installed-app readiness |
| Local models | infrastructure choice | core value proposition |

## Current Business Priorities

1. Prove one outside-user first win.
2. Package that win into a repeatable activation script.
3. Turn repeated steps into HII capabilities.
4. Keep the public site focused on the first-win behavior.
5. Keep Network, marketplace, social, remote, and commerce work behind evidence
   gates unless a client needs the exact slice.

## Weekly Operating Review

Every week, answer these in order:

1. Which customer or user got a verified result?
2. What was the source context?
3. What did HII make, change, or coordinate?
4. What proof exists?
5. Did they use it again?
6. What part should become a reusable capability?
7. What should be removed from the pitch because it did not help the loop?

The weekly artifact should be a short ledger, not a deck.

## Daily Operating Procedure

Start each meaningful HII business/product session with this short pass:

1. Run `hii home --json` and check current repo/runtime state.
2. Check `git status --short --branch` from `/Users/ummi/hii`.
3. State the intended outcome in one sentence.
4. Classify the work as Studio, Product, Network, or Parked.
5. Name the proof required before the work can be called done.

Then use the lane-specific rule:

| Lane | Default action | Done means |
| --- | --- | --- |
| Studio | deliver one concrete outcome for a named person or business | result, receipt, and handoff exist |
| Product | improve the repeatable HII loop | tests or live local proof show the loop improved |
| Network | build only the narrow shared-object/account slice needed by current evidence | authority, identity, sync, and revocation proof exist |
| Parked | record the idea without building | parked note has trigger evidence for revisiting |

When in doubt, bias toward Studio. Revenue and user evidence clarify the
product faster than internal architecture debates.

## Documentation Operating Procedure

Use this rule before adding or changing HII docs:

| Doc type | Location | Purpose |
| --- | --- | --- |
| Business operating docs | `docs/business/` | current offers, customers, metrics, activation, and weekly reviews |
| Architecture decisions | `docs/decisions/` | accepted durable technical/product constraints |
| Launch assets | `docs/launch/` | posts, scripts, storyboards, campaigns, and channel copy |
| Evidence records | `docs/records/` | dated proof, handoffs, audits, and completed slices |
| Marketing research | `docs/marketing/` | audience, channel, and positioning research |
| Product truth | `README.md`, `docs/HII_AII_MASTER_CONTEXT.md` | canonical current definition and boundary |

Do not create a new top-level strategy doc if the idea fits one of these
folders. Add a short dated record when the work is evidence; update the
business docs when the operating rule changes; update an ADR only when the
architecture rule changes.

## File Organization Recommendation

Keep business docs in one cluster:

```text
docs/business/
  structure.md              operating map and procedures
  offers.md                 offer ladder and current prices
  customer-discovery.md     interviews, hypotheses, objections
  activation-playbook.md    $500 founder activation process
  proof-stories.md          consented redacted outcomes
  metrics.md                first receipt, second receipt, margin, incidents
```

Then treat existing docs as source material:

- `docs/PITCH.md` is investor narrative.
- `docs/LAUNCH_AND_MONETIZATION.md` is launch contract.
- `docs/HII_FIRST_WIN_LAUNCH.md` is acquisition framing.
- `docs/decisions/006-service-led-business-workspaces.md` is the client-workspace architecture.
- `docs/HII_USER_OWNED_NETWORK.md` is long-term platform economics.

## Decision Rule

When a new HII idea appears, classify it before building:

```text
Is it a customer outcome we can sell this week?        -> Studio
Is it repeated enough to become product behavior?      -> Product
Does it require shared identity, objects, or exchange? -> Network
Is it only interesting architecture?                   -> Park it
```

The business gets simpler when HII sells outcomes first, productizes repetition
second, and platforms only what has earned its place.
