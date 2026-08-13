# HII Live Stream and Personal World Model

## Thesis

HII is a user-owned reality graph and inference interface. Voice, text, CLI,
canvas, Unicode, 3D territory, and physical markers are projections over the
same durable objects. The system refines user intent into goals and bounded
physical action without silently claiming, exporting, or monetizing private
life context.

```text
LifeGoal -> LifeObjective -> Need | Want -> SolutionOption
         -> BoundedRun -> Change -> Proof -> Outcome -> LearnedSkill
```

The user alone activates a life goal. HII may propose a draft based on repeated
intent, with the observations and uncertainty visible.

## Intelligence and rendering

The high-intelligence loop interprets objectives, sources, significance,
privacy, constraints, and consequences. It emits typed semantic events and a
compact `RenderFrame` only when meaning changes. A cheap deterministic renderer
lays out text, Unicode, motion, maps, images, meters, and expandable evidence.
It never uses another model to decide how every row should look.

```text
world model + live evidence
          -> high-intelligence reducer
          -> RenderFrame
          -> deterministic local renderer
          -> user voice/text steering
          -> typed steering event
          -> world-model update
```

A frame contains stable IDs for the objective, system state, focus event,
threads, attention items, meters, proof, controls, detail references, and
expiry. The top objective and bottom steering surface stay fixed. `NOW` flows;
thread rows update in place; unresolved warnings persist; completed events
collapse into checkpoints.

## Time and legibility

Every authoritative event retains millisecond time. The renderer may update
activity at 50-250 ms, but coalesces repeated deltas into semantic observation
frames around 250-1000 ms. Focusing a row reveals exact timing and raw evidence.
No events are discarded by presentation coalescing.

The human stream never prints serialized strings with literal `\n`, unbounded
tool output, full model responses, or duplicate blocks. Raw journals remain
available through explicit detail expansion and `hii stream --jsonl`.

## Shared agent event contract

Normalize existing HII journals on read before migrating writers. Preserve the
published `schemaVersion`, `event`, `atUnixMs`, and `data` fields and add sparse
joinable scope:

```json
{
  "schemaVersion": 1,
  "event": "tool.result",
  "atUnixMs": 0,
  "source": "cli.run",
  "scope": {
    "workspace": "...",
    "objectiveId": "...",
    "runId": "...",
    "parentRunId": "...",
    "agentId": "...",
    "needId": "...",
    "placeId": "..."
  },
  "data": {}
}
```

All agents emit concise interpretations, coordinates, source references,
actions, bounded change/diff references, proof, resource usage, cost,
feasibility, blockers, approvals, and next checkpoints. They do not emit
private chain-of-thought. Full diffs and artifacts are referenced by path and
hash instead of copied into every event.

## Objective loop

```text
objective + done-when + token/time/cost budget + authority
       -> observe -> infer -> act -> diff -> verify
       -> compact checkpoint -> continue | steer | fund | stop
```

Provider token usage arrives after each model call. The token ceiling is
therefore enforced at the next action checkpoint and may be crossed by one
call; it is not an exact mid-token kill switch. Steering modifies the active
objective or constraints without discarding accumulated evidence.

Delegated agents inherit objective ID, parent run, authority, privacy, and
token/resource ceilings. They cannot expand their own budget, authorize their
own purchases, or create goals on behalf of the user.

## Physical needs and wants

`Need` and `Want` remain separate typed objects bound to place, affected people,
evidence, urgency, stewardship, authority, privacy, and desired conditions.
Wants cannot displace unmet needs through an opaque score.

```text
physical observation -> Need | Want -> evidence + place binding
-> generated or matched solutions -> visualized consequences
-> intelligence + labor + materials quote -> human authorization
-> execution -> field verification -> world-model update
```

Generated images and diffusion previews are illustrative proposal surfaces.
Accepted intent becomes a semantic change set applied to exact geometry; code,
cost, environment, access, displacement, and constructability analysis runs on
the semantic model rather than pixels.

## Resource vitality

Vitality measures the user or community's capacity to achieve an authorized
objective. It is never an agent survival instinct. Track money, liabilities,
time, skills, compute, tools, materials, labor, property or access rights,
providers, and funding programs as source-labelled snapshots.

Separate resources that are owned, presently available under stated terms, and
merely possible. Keep estimate, quote, reservation, invoice, payment, subsidy,
and reconciliation as distinct facts. Feasibility is a vector with hard gates
for authority, safety/legal review, consent/privacy, liquidity/reserves,
capacity, fresh evidence, and spending approval.

An agent may request more compute only for an explicit objective, measured
capability gap, expiring quote, shown alternatives and consequences, bounded
benefit, and user authorization. Family, care, civic, and public-good goals may
be intentionally subsidized even when they are not commercially profitable.

## Data lifecycle

```text
HOT      live semantic frames required for current inference
WARM     compact checkpoints with hashes and source references
COLD     compressed raw journals retained for replay and audit
RECYCLE  reviewed lessons, metrics, and skill candidates from proven work
TRASH    expired duplicates, recoverable until retention deadline
PURGE    explicit user-authorized removal with a tombstone receipt
```

Recycling means resumable and re-projectable, not automatically shareable or
monetizable. Credentials, payment identifiers, exact private finances, raw
voice or biometrics, precise home locations, health/legal records, private
family/lineage/sacred knowledge, full prompts, and chain-of-thought never enter
the general stream. Emit redacted summaries, ranges, hashes, and encrypted
purpose-scoped references.

## Implementation order

1. Read-only `hii stream` normalizer over existing run journals.
2. Durable LifeGoal, LifeObjective, Need, Want, Place, and Territory IDs.
3. Thread objective, parent-run, delegation, authority, and budgets through
   runs, board tasks, background agents, receipts, and schedules.
4. Add bounded Git mutation events, checkpoints, and inbox-based steering.
5. Add resource snapshots, feasibility, quote, approval, and reconciliation.
6. Add territory baseline, semantic 3D change sets, generative previews, and
   physical field-proof workflows.
7. Extract and review repeatable verified paths as HII skills.

`~/.hii` remains the canonical user-owned runtime for journals, receipts, and
private graph state. This repository owns code, schemas, projections, and
reviewed documentation; it references runtime evidence instead of committing
sensitive user data.
