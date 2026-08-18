> **Superseded in part, same day.** Written before the decision that HII comes
> into the user's world rather than importing the world into HII. The receipt
> mechanism and the typed-verb evidence below still hold; the proposed
> `capture → compose → revise → export` verb set does not.
> See `2026-08-18-system-native-spine.md`.

# The One Loop: HII's Spine, Found Not Built

**Date:** 2026-08-18
**Status:** Decision record; companion to `2026-08-18-cross-chat-hii-synthesis.md`
**Method:** Direct execution against the installed runtime and a survey of all
442 parseable receipts in `~/.hii/runs/cli`

## The finding

HII's thesis is already implemented, once, all the way through. It is `hii info`.

Nobody noticed because it sits behind twenty sibling subcommands, in one of
eleven HII trees, with no surface pointing at it.

The synthesis document asks for a first-win loop:

```text
one deliverable → useful sources → source-backed objects → one editable
artifact → non-destructive revision → real export → receipt linking intent,
sources, transformations, verification, and output
```

Executed today against `https://en.wikipedia.org/wiki/Provenance`:

```text
hii info capture  → source:bc94816a...  (content, 11 image objects, rawHash + contentHash)
hii info changes  → immutable captured version, hash 6a29edfe...
hii info export   → artifact + receipt info-e91dd550-...
```

The resulting receipt is the object the whole product is about:

```json
{
  "goal": "Export Provenance - Wikipedia as a source-backed Markdown artifact",
  "context_sources": ["https://en.wikipedia.org/wiki/Provenance"],
  "verification": [{ "command": "re-read canonical information state and verify content hash",
                     "ok": true, "output": "verified" }],
  "artifacts": ["…/provenance.md"],
  "authority": "workspace",
  "done_when": "durable source or artifact exists with provenance and content hash",
  "reversible": true,
  "status": "completed"
}
```

Intent, sources, transformation, verification, output, authority, reversibility
— in one inspectable record, produced by a real command, on real material.
That is the product. It exists.

## Why this reframes the work

The task was never "build the receipt layer." It is: **recognize the one place
the thesis is already true, name it the spine, and make everything else conform
to it or get cut.**

The receipt corpus supports this. Across 442 receipts:

| Field populated | Count | Share |
| --- | --- | --- |
| `verification` | 307 | 69% |
| `context_sources` | 305 | 69% |
| `done_when` | 315 | 71% |
| `artifacts` | 68 | 15% |
| `token_usage` | 42 | 10% |

Outcomes: 250 completed, 88 null, 28 deadline, 25 stuck `running`, 18 aborted,
15 loop-abort, 6 verify-failed.

The pattern is unambiguous. **Typed, narrow verbs produce real proof. The
generic agent loop produces noise.** The `hii info` path emits a complete,
verified receipt every time because the verb knows what "done" means. The
generic `hii run` path leaves 88 receipts with a null outcome and 25 permanently
"running," because a general agent loop cannot declare completion it does not
understand.

This is the concrete, numeric form of the standing critique: reimplementing an
agent loop is not the differentiated work, and it is actively degrading the
proof layer that is.

## The four gaps in the spine

The loop runs end to end. It is not yet good. Each gap is small and specific.

### 1. Extraction is unfiltered — the object is source-backed but not useful

The exported artifact is 71,714 bytes / 1,418 lines. The first real sentence of
the article appears at **line 158**. Everything above it is Wikipedia navigation
chrome — "Main page / Contents / Current events / Random article / Donate / Log
in" twice over, plus every interlanguage link.

The synthesis promises Readability-style extraction. It is not being applied.
This fails product test #2 directly: it does not reduce the distance from
thought to useful artifact, it adds 157 lines of distance.

**Fix:** apply Readability (or equivalent boilerplate removal) in the capture
path, before hashing. Store both `rawHash` and the extracted `contentHash` —
both fields already exist in the schema.

### 2. Captured images are orphaned

Capture produces 11 image objects, each with `id`, `sourceId`, `url`, `alt`,
`context`, and `position`. The export embeds **zero** of them.

The object model already records everything needed to place them correctly.
The export renderer simply ignores the relation.

### 3. There is no transformation verb

`hii info` goes capture → export. The synthesis specifies a derived object
recording parent version, intent, authority, model, parameters, changed region,
output hash, verification, and cost. No command produces one.

Without this there is no "editable artifact," no "non-destructive revision," and
no lineage chain — three of the seven steps in the first-win loop. This is the
single largest missing piece, and it is one verb.

### 4. One source in, one artifact out

There is no composition. The synthesis loop is *sources* (plural) → project
model → artifact. Today a deliverable cannot be assembled from more than one
captured object, which means the "project model" primitive has no expression.

Related: `completion` is `null` on the info receipt even though `cli/src/completion.rs`
contains a full completion-contract engine with unmet-criteria reasoning. The
typed path does not call it.

## The cut list

Everything below stays in the tree and stops receiving effort until the four
gaps above are closed:

- the generic `hii run` agent loop (it is the source of the null-outcome receipts)
- `systems` / `on` — remote enrollment stays `pending-agent` with no transport
- `acp-serve`, `mcp-serve`, `tools-manifest` — protocol surface with no proven consumer
- `discover`, `project`, `schedule`, `board`
- the menu bar, and every canvas feature not rendering a captured object
- ten of the eleven HII trees; `~/hii-newest` is the repo of record per `hii home`

The test for re-entry is product test #7: can it be proved in the actual surface
where the claim matters?

## Next five commands

```text
1. hii info capture <url>          → extracted content, not raw chrome
2. hii info inspect <id>           → shows images as placed relations
3. hii info compose <id> <id> …    → NEW: a deliverable from multiple sources
4. hii info revise <artifact-id>   → NEW: derived object, parent-linked, hashed
5. hii info export <id> --output   → embeds images, calls the completion contract
```

When those five run clean on one real deliverable, the synthesis document is no
longer direction. It is a description of working software, and the canvas
becomes a rendering of objects that already exist rather than a place where the
thesis is attempted again.

## What this record does not claim

- Nothing here was committed. The four gaps are unfixed.
- The extraction, image, compose, and revise findings come from one capture of
  one Wikipedia page. The receipt-corpus numbers cover all 442 parseable
  receipts, but 41 run directories held no parseable `receipt.json`.
- The canvas was not exercised. All claims are CLI-surface claims.
