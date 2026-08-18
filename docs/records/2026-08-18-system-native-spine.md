# The System-Native Spine

**Date:** 2026-08-18
**Status:** Decision record. Supersedes `2026-08-18-one-loop-spine.md` in part.
**Definition adopted:** HII is your information interface — the agent for your
computer. It comes into your world; you do not enter HII's.

## What I retract

Earlier today I proposed `hii info capture → compose → revise → export` as the
product spine. Under the definition now adopted, that is the anti-pattern.

`hii info capture <url>` pulls a web page into HII's own object store and emits
a Markdown copy. That is importing the user's world into HII. The `compose` and
`revise` verbs I proposed would have built HII's own document model — a headless
canvas. Same mistake, no pixels.

## What survives, and why it matters more now

The receipt thesis is unchanged and strengthened. "You own the information,
approve consequences, and can inspect what happened" is the receipt, restated as
a promise.

The typed-verb evidence is unchanged. Across 442 parseable receipts:
verification populated in 307, context_sources in 305, done_when in 315,
artifacts in only 68, token_usage in only 42. Outcomes include 88 null and 25
permanently `running`. Typed verbs that know what done means emit complete
receipts. The generic agent loop emits noise.

**And one mechanism transfers exactly.** The reason the `hii info export` receipt
was complete is its verification step:

```text
"re-read canonical information state and verify content hash" → ok
```

It did not trust the agent's report. It re-read the canonical state and checked
it. That is precisely the verification a system-native action needs. The only
thing that changes is where canonical state lives:

| | canonical state | verify by |
| --- | --- | --- |
| old (wrong noun) | `~/.hii` captured copy | re-read HII's store |
| new (right noun) | the user's file, Mail draft, Rhino document, Note | re-read the native app |

`hii info` proved the receipt mechanism on the wrong noun. Keep the mechanism.
Change the noun.

## The pivot is also already half-built

`macos/Sources/HiiBar/` contains `AppDelegate.swift`, `HotKey.swift`,
`ChatPanel.swift`, `ChatModel.swift`, `main.swift`. A global hotkey opens a
panel, sends intent to the CLI, streams stdout back, writes a receipt, and
exposes `revealReceipt()`. Three real sessions exist in `~/.hii/bar/sessions/`.

That is the Granola/Wispr-shaped entry point, working today.

Also present: `~/.hii/context/timeline.jsonl`, `~/.hii/skills/apple-context.json`
(Messages, Contacts, Notes, Reminders, Mail), `cli/src/picker.rs`,
`file_explorer.rs`, `keyboard.rs`, `lib/server/termite-jobs.ts` for Rhino, and a
41-entry capability map.

## The one real gap

HiiBar has **no perception of the user's world**. Its first act is
`chooseWorkspace()`. A recorded session reads:

```json
{"text":"hello","mode":"build","authority":"workspace","role":"human"}
```

Authority is a *workspace*. Not the frontmost app, not the selection, not the
open document. There is no `NSWorkspace.frontmostApplication`, no Accessibility
selection read, no active-document query anywhere in the bar.

So the entry point still says "enter HII's world" — through a smaller door.
And nothing anywhere verifies a write *back* into a native app. `hii info`
verified against its own store; nothing verifies that the draft is actually in
Mail or the layer actually exists in Rhino.

Those are the two things to build, and they are the only two:

1. **Perception.** Frontmost app, window title, selection, active document path,
   recent files. Populate `context_sources` from the user's world instead of
   from a captured copy.
2. **Native write-back verification.** Act through the app, then re-read the
   app's state to confirm the consequence. One verifier per app, starting with
   the three with live bridges: Finder/filesystem, Apple apps via apple-context,
   Rhino via Termite.

## Acceptance test

One deliverable, done_when declared before the work:

> With Rhino frontmost and a model open, press the hotkey and say "save a
> material-options note for this model next to the file." HII reads the active
> Rhino document without being told which one, writes a real note beside the
> real project file, verifies by re-reading the note from disk and the document
> from Rhino, and leaves a receipt naming the intent, the observed context, the
> app it acted through, the verification, and the output path.

No canvas. No captured copy. No workspace chooser.

## Cut list

Everything not serving perception or native write-back verification:
the canvas as product architecture, the generic `hii run` loop, `systems`/`on`,
`acp-serve`/`mcp-serve`/`tools-manifest`, `discover`, `project`, `schedule`,
`board`, `hii info` composition work, and ten of the eleven HII trees
(`~/hii-newest` is the repo of record per `hii home`).

## Boundaries of this record

Nothing was committed. The Rhino acceptance test has not been run. HiiBar was
read, not executed. The 442-receipt figures cover `~/.hii/runs/cli` only; 41 run
directories held no parseable receipt.
