# HII governed proposals demo

Date: 2026-07-30
Status: verified working copy; not published
Format: 31-second, sound-off X clip

This concept was red-teamed by Claude Opus 5 in read-only session
`316086a5-c3b8-4ccf-91c7-f1857b1c64a6`. Opus reviewed supplied verified facts
with no tools, edits, or browsing. It returned `revise`, not automatic
approval. HII's implementation and local receipts remain the authority.

## Product idea

> Two agents asked to put work in my active lane. HII held it for review until
> I approved.

The demo is for independent multidisciplinary makers whose name is on the
deliverable. It shows one narrow contract:

- agent and system tasks retain origin and requested lane;
- generated requests for `next` or `doing` land in backlog as proposals;
- a generated proposal must name a bounded outcome, why/context, and at least
  one `Done when` criterion before approval becomes available;
- an exact open duplicate returns HTTP 409 before another event is appended;
- a proposal cannot enter `next` or `doing` until a human approval is recorded;
- a person can refine or archive the proposal without activating it;
- human-created intent remains visibly distinct;
- the append-only ledger retains the move.

It does not demonstrate containment of a hostile agent, general semantic
deduplication, safety, correctness, or autonomous execution.

## Recording setup

Use a fresh isolated `HII_RUNTIME_DIR`. Keep the HII board at roughly 75% of
the frame. Show a small terminal pane only for the two API responses and the
final `hii board` readout. Use the real product typography, white canvas,
electric-blue proposal edge, black ledger strip, and no decorative AI avatar.

Keep these visible at phone size:

- the `PROPOSAL` label;
- `origin: system`;
- `Requested next`;
- `Needs definition` changing to `Definition ready`;
- one visible `Done when` criterion;
- the backlog count;
- the human origin label;
- the explicit approval button;
- the destination lane after approval.

## Beat 1 — 0–4s

Picture: Empty `next` lane and an agent request for one launch task.
Caption: `An agent asked for my active lane.`

## Beat 2 — 4–9s

Picture: The card appears in backlog with `PROPOSAL`, system origin, and
`Requested next` visible. Its title-only request reads `Needs definition`.
Caption: `Requested NEXT. Still missing “done when.”`

## Beat 3 — 9–14s

Picture: Replay the exact request. Show HTTP 409 in the terminal while the
backlog card count remains `1`.
Caption: `Exact open duplicate → 409. Count stays 1.`

## Beat 4 — 14–19s

Picture: Add `Verify the founder demo handoff` through the human-intent field.
Hold on the new card's `human` origin.
Caption: `My intent is marked HUMAN.`

## Beat 5 — 19–25s

Picture: Show the unapproved move returning
`BOARD_TASK_APPROVAL_REQUIRED`, then add the real why/context and one visible
`Done when` criterion. Hold on `Definition ready`, then click
`Approve to next`. The proposal moves only after that recorded action.
Caption: `Defined. Reviewed. Then approved.`

## Beat 6 — 25–31s

Picture: Hold the approved card in `next`, then show `hii board` reporting
origin, lane, and approval state from the append-only ledger.
Caption: `Who asked. Who approved. What moved.`

End question:

> What would you never let an agent move on its own?

## X post

The canonical working copy is `docs/launch/x-post.txt`. Keep `[video]` as an
editorial marker, not a literal placeholder in a published post.

## First reply

The canonical working copy is
`docs/launch/hii-governed-proposals-first-reply.txt`.

The reply qualifies real makers by asking about a specific artifact and their
current final check. Do not redirect into abstract AI-governance discourse.

## Production proof

The interaction passed against an isolated local runtime:

- generated `doing` request landed as a backlog proposal;
- exact normalized duplicate returned HTTP 409 and named the existing task;
- direct promotion without approval returned
  `BOARD_TASK_APPROVAL_REQUIRED`;
- title-only approval returned `BOARD_TASK_LOW_QUALITY` without activating the
  proposal;
- saving why/context plus `Done when` changed the persisted card to
  `Definition ready`;
- browser approval moved the task into its requested lane;
- archive recorded a done-lane event without approval or a run;
- human intent was recorded separately with `origin: human`;
- Rust and compatibility CLIs exposed the same proposal and approval state;
- the live HII board remained readable at desktop capture size.

Implementation gate:

```text
npm run hii:board:check
npm run hii:governed-proposal-launch:check
npm run ci:release-candidate
```

## Claim guardrails

- Say HII **held a task as a proposal**. Do not say it refused, protected,
  sandboxed, contained, or made the agent safe.
- Say HII rejects an **exact open duplicate**. Reworded near-duplicates are not
  covered by this proof.
- Say a human approval was recorded before lane activation. Do not imply a
  public release, waitlist, funded cohort, unlimited autonomy, or availability.
- Say HII requires **why/context and a concrete `Done when` criterion** for a
  generated proposal. Do not claim semantic task quality, correctness, or an
  LLM safety judgment.

## Product signal

The useful response is not agreement that “AI needs oversight.” It is a maker
naming a real artifact, the point where their name becomes accountable, and
the check they currently perform before AI-touched work moves forward.

Track:

- replies containing a concrete artifact or deliverable;
- replies naming the current check or handoff;
- questions about what the ledger records;
- requests to try the behavior on the person's own project.

Likes and abstract guardrail debate may indicate reach. They do not validate
the product need.
