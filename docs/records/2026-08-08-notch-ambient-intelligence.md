# Slice 10 — The Notch as ambient intelligence

Date: 2026-08-08
Branch: `release/new-user-ready`

## Change

The Notch answers one question: *what needs my attention right now?*

It was deciding that from a handful of independent booleans — `busy`,
`speechBusy`, `isListening`, `error`, `proposals.length`, `latestQueuedRunId` —
which multiply into combinations nobody enumerated and which could contradict
each other. Two of them could be true and the surface would show whichever the
template checked first.

`lib/notch/ambient-state.ts` resolves them to exactly one state with exactly one
message and one primary action. Everything else is secondary, behind a reveal,
because a surface that offers three equally weighted choices is asking the human
to decide what it should have decided.

## The ordering is the policy

States are ranked by how much they need a person:

```
ERROR > WAITING_FOR_APPROVAL > PROPOSAL_READY > WAITING_FOR_USER
      > LISTENING > TRANSCRIBING > INTERPRETING > CAPTURING > QUICK_CAPTURE
      > WORKING > QUEUED > COMPLETE > IDLE
```

An error outranks work in progress because a broken thing invalidates it. A
decision waiting on a person outranks a machine that is busy. With that ordering,
"what needs my attention" has one answer rather than several competing ones.

`PROPOSAL_READY` and `WAITING_FOR_APPROVAL` are kept distinct: "HII worked out
what you meant" and "this has been sitting unanswered" are different moments, and
collapsing them makes a fresh interpretation look like a neglected one.

## Collapse and focus follow attention

- An error stays open until acknowledged. Collapsing it would be HII deciding the
  human had seen something they may not have.
- A satisfied result fades after six seconds; an unmet declared outcome does not.
- Progress collapses after four seconds — it does not need a human, so it should
  stop occupying attention.
- Focus moves into the surface only where the human is expected to act.

Every state names its target (`run`, `proposal`, `workspace`, `object`) so
"return to the thing this is about" is a property of the state rather than a
guess by the surface.

## Native mechanics untouched

Positioning, always-on-top, all-spaces behaviour, expansion/collapse, focus-loss
handling and the global shortcut all stay in the Tauri layer. Nothing in this
slice rebuilds them; the change is what the surface *says* and *offers*.

## Cross-window selection

The Notch reads the ephemeral selection channel from Slice 4 and shows a count.
The ids are resolved server-side against the persisted workspace, so a spoken
"make a variant of these" can mean the objects selected in the other window
without any of that state entering `WorkspaceDoc`.

## Upstream study

`boring.notch` — https://github.com/TheBoredTeam/boring.notch — was read for
interaction and native-lifecycle principles only.

- Revision studied: `74ac6678bc6936be4ac75aa8ed5b72e5db46e55f` (2026-08-05)
- License: GPL-3.0

No source code, visual identity or branded assets were copied. HII's Notch is a
Tauri window with its own implementation; the influence is limited to the idea
that an edge-of-screen surface should be an ambient answer rather than a
dashboard.

## Not done

Packaged Tauri proof — open/close, shortcut, voice proposal, approval, active
run, completion, error, return-to-object — was **not** executed in this pass. The
Voice capability status stays `partial` for exactly this reason: microphone
behaviour and native lifecycle in the packaged application have not been
exercised, so no claim is made about them.

Dashboard-level history and runtime counts still render in the Notch's expanded
panel. Moving them into the main app is a follow-up; the state model no longer
depends on them.
