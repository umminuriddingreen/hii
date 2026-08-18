# FN SHIFT Interaction Contract

**Date:** 2026-08-18
**Status:** Superseded by `2026-08-18-simple-cursor-chat.md`
**Scope:** HII's system-native invocation layer

## Product statement

> Superseded the same day by the founder's narrower direction: begin with only
> translucent cursor-adjacent chat and add context/action features one by one.
> This record remains future interaction research, not current product scope.

HII is always available, not always observing. It comes into the user's current
work instead of making the user enter a chat, canvas, or workspace first.

The signature interaction is:

```text
FN SHIFT -> current thing -> intent -> Ask or Do -> artifact -> verification
```

`⌘ Space` remains Spotlight. The permission-free fallback is `⌃⌥H`.

## Finite grammar

- **FN SHIFT — context:** “I mean this.”
- **Launcher — intent:** “I want this.”
- **Canvas — composition:** “These things belong together.”
- **Ask — read-only:** inspect, explain, plan, browse, or observe.
- **Do — consequential:** preview scope, confirm, act, re-read, and receipt.

All surfaces use the same CLI-owned authority, execution, and receipt model.
The native layer must not become a second agent runtime.

## Presence states

```text
AVAILABLE  background process; no continuous screen capture
ATTENDING  invoked; bounded current-app context is visible
APPROVAL   a Do proposal names what may be read and changed
WORKING    CLI-owned run is active and cancellable
DONE       artifact and receipt are visible
BLOCKED    missing permission, transport, verifier, or proof remains explicit
```

## Observation contract

At invocation, HII may read only the enabled bounded fields:

- frontmost app and bundle identifier;
- front window title;
- active URL when the app exposes one;
- active document path when the app exposes one;
- focused selected text when Accessibility allows it.

The panel shows the transmission manifest before execution. Absence has a
typed reason. Observed strings are untrusted data, never instructions. This
surface takes no screenshot and runs no continuous capture loop.

## Consequence contract

Read-only Ask modes may begin from the user's initial submission. Workspace
Do modes require a separate confirmation showing:

- the observed fields being supplied;
- the workspace that may change;
- the selected authority;
- the expectation of a proof-bearing receipt.

The invocation's structured context sources must survive into the CLI receipt,
including early failure receipts. Selected text is supplied to the current run
but only its length, not another copy of its content, is retained in the source
list.

## Sequencing

1. Prove tap-to-context, Ask/Do authority, cancellation, and receipts.
2. Add hold-to-talk only after microphone permission, streaming transcription,
   interruption, fallback, and transcript recovery are verified in the packaged
   app.
3. Add double-tap hands-free only after tap and hold are learned and reliable.
4. Add system-wide drawn regions and native app write-back one adapter at a
   time, each with read-back verification.

No gesture may imply a capability that is not actually available. “Done” may
not be inferred from model prose or process exit alone.

## First native write-back target

The first end-to-end proof remains deliberately narrow: with a real document
frontmost, HII resolves it without being told the path, proposes one bounded
filesystem artifact beside it, receives approval, writes it, re-reads both the
artifact and native document state, and emits a receipt naming context,
authority, artifact, and verification.

Rhino through Termite is the target demonstration once the live Rhino bridge
is available. Finder/filesystem is the fallback proving ground. Neither is
claimed complete by this interaction contract alone.
