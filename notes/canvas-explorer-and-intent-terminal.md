# Note — HII canvas as a file explorer + a plain-text terminal

**Date:** 2026-08-21 · **Repo:** /Users/ummi/hii · **Status:** thinking scaffold, in-progress
**Purpose:** capture *my* vision of the HII canvas as (a) a visual file viewer, (b) an
interactive file explorer, (c) an organizational file explorer — and the "a terminal the
user can send plain text to" idea that ties them together.
**Grounding:** every "exist today" line cites the current code. "Open" lines are for me
to fill. This is a scratchpad, not a spec — the spec would be a `docs/` ADP once the
thinking is settled.

---

## 0. The thesis (my own words, sharpen)

Two layers over **one object graph**:

- **Canvas = space.** You arrange, view, and reorganize *objects* (nodes) by hand and
  gesture. It is spatial, visual, and tactile.
- **Terminal = intent.** You send *plain text* — one line of natural language — and it
  becomes a bounded capability run that returns a visible result and a proof/receipt.

They are not two products. The terminal is the **mouth** of the same canvas: it creates,
queries, and reorganizes the very nodes you then manipulate on the canvas. Product wedge:
`object + text/voice intent → bounded capability → visible result → proof → durable receipt`.

**Open — fill:** is the terminal a node *on* the canvas, a persistent *surface* (fixed bar /
the "you" participant), or both? Do they ever separate?
> Your thoughts:

---

## 1. What already exists (do not re-prove; reuse)

| Idea | Lives today at | What it does |
|---|---|---|
| Visual viewers | `lib/workspace/ingest.ts` `seedFromFile` | Produces viewer nodes: interactive **3D model**, **DXF**, **PDF**, **image**; non-previewable files fall back to metadata-only |
| Visual viewer (reduced) | `components/spaces/space-surface.ts` | Spaces touch surface allows only `image / canvas-text / ink`; `terminal / browser / agents / receipts / applications` = **false** |
| Image organization | `lib/workspace/contact-sheet.ts`, `image-library.ts`, `image-similarity.ts` (perceptual hash) | Contact sheets, stacks, similarity search up to 80 items / 12 selected |
| Interactive: modes | `lib/workspace/canvas-modes.ts` | `build / plan / browse / see / show`; `see` & `plan` & `browse` are read-only, `build` & `show` mutate |
| Interactive: gestures | `lib/workspace/gestures.ts` | rAF-batched pointer core, always tears down (no orphan listeners) |
| Interactive: ink | `lib/workspace/ink.ts`, `components/spaces/InkBody.tsx` | handwriting/annotation body |
| Interactive: selection | `lib/workspace/selection.ts` | select nodes (spatial) |
| Intent interpreter | `lib/workspace/canvas-intent.ts` | plain text → **only** unambiguous local ops (`fit-all / focus / delete / duplicate / tidy / move`); unknown text falls through to an agent |
| Org structure | `lib/workspace/organize.ts` + `scenes.ts` | a *selected* set of nodes → a `frame`/`scene` (parent `frameId`), with a human audit entry |
| Search-as-navigate | `lib/workspace/search.ts` | ranked term search over node titles/fields → up to 12 results |
| Terminal node / operator | `lib/workspace/terminal-command.ts` `/terminal [folder]` | persistent local operator terminal, **no command started by default** |
| Terminal node / agent | same file, `agentTerminalSeedFromText` | direct canvas typing → starts an agent in a mode with bound context nodes |
| Persistence seam | `useWorkspace.ts`, `workspace-store.ts` | document read/write, undo/redo, optional authoritative `subscribe` (connected Spaces only) |
| Spaces = canvas+identity | `docs/SPACES_ARCHITECTURE.md` §0 | "A Space is a workspace with an identity record, a policy, and a host." Partition the operational graph by `space_id` |

---

## 2. Lens A — canvas as a **visual file viewer**

**The claim:** the canvas is first a *viewer* — drop a file, see it; arrange many views
side by side; read the world visually.

**Exists today:** image / 3D / DXF / PDF viewers + contact sheets + perceptual-hash
similarity. `see` mode = "read the canvas and computer state, change nothing."

**Open / gaps to decide:**
- Which file types are *real* viewers vs. metadata-only? (text/markdown, code, audio,
  video, terminal output, git diff, spreadsheets, archives/zip contents). What is the
  *minimum* viewer to feel like "opening a file" for each?
- Is a viewer a **projection of a path on disk** (read-only mirror of the real file) or a
  **copied/owned object** (HII holds the bytes)? Trust/proof angle matters — AGENTS.md
  rule: objects carry `owner / status / audit`.
- Viewer density: the reduced Space touch projection is intentionally minimal
  (image/text/ink). Is the *full* canvas explorer a **different capability set on the same
  node model**, not a new app? (I lean yes.)

> Your thoughts:

---

## 3. Lens B — canvas as an **interactive** file explorer

**The claim:** you *act* on files with your hand — drag, pinch, select, ink over them,
rearrange. The explorer is tactile, not a menu.

**Exists today:** gesture core, ink, selection, canvas modes, and the plain-text intent
interpreter that already turns "fit all / open X / delete these / tidy" into actions.
`browse` mode explicitly = "search + load source context" (a research/explorer verb).

**Open / gaps to decide:**
- Is "exploring" a *spatial* act you mostly do with gesture, or do you need a keyboard/
  command surface *on top* of the gesture (the terminal, see §5)?
- The intent interpreter is deliberately conservative — it only acts on unambiguous
  phraseology and defers everything else to an agent. Is that the right trust boundary, or
  does an explorer need more direct, less-ambiguous commands (e.g. "move to folder",
  "tag", "mark done") that are *local* and don't need an agent?
- What does "interactive" mean for the *reorganization* action specifically — drag into a
  frame today is manual; could an intent auto-organize?

> Your thoughts:

---

## 4. Lens C — canvas as an **organizational** file explorer

**The claim:** the canvas keeps your world *ordered* — not just showing files but structuring
them into meaningful groups you can navigate and recall.

**Exists today:** selection → `frame`/`scene` grouping with a human audit entry; scene
ordering + adjacency (next/prev between scenes); type summaries; ranked search.

**Open / gaps to decide:**
- Today's organization is **flat + selection-based** (group *what you picked* into one
  frame). Do you need **hierarchy / nesting / trees / breadcrumbs**, or is the flat scene
  model deliberately enough? (Nested frames need a parent pointer that `frameId` almost is.)
- Is the organizational unit a **scene** (a curated set), a **folder** (a path-like
  container), or a **concept/tag** (a non-exclusive view)? These are different models — pick
  one primary, map the others to it.
- How does organizing *persist and prove*? Today it writes a `human` audit entry into the
  scene node. Is that the receipt? Should "move to X" be an operator-controlled, local-only
  action (matches `hii.terminal.observe` / local-only execution discipline)?
- Search-as-navigate today returns a ranked list. For "exploring a file system" do you want
  **search that rearranges the canvas** (results fly into a scene) rather than a list panel?

> Your thoughts:

---

## 5. The plain-text **terminal** (the binding idea)

**The claim:** we just need *a terminal the user can send plain text to* — one line in → a
bounded, proof-backed run out, whose results land as objects on the same canvas. This is the
intent mouth for the whole explorer.

**Exists today:**
- `/terminal [folder]` → a persistent **local operator terminal** node, no command started.
- Direct typing on the canvas → an **agent terminal** that binds + starts in a mode, carrying
  up to 100 context (selected) nodes.
- `interpretCanvasIntent` is the seam: unambiguous local phrases act directly; everything
  else becomes an **agent intent** with a mode instruction.

**Open / gaps to decide — this is the heart of it:**
1. **Form.** Is the terminal (a) a node on the canvas, (b) a persistent bottom bar / input
   strip, or (c) a "you as a participant" surface in a Space? Which one is the *default*?
2. **Routing.** Plain text must map to a route. The board already carries "design one
   authoritative *automatic* model router (config-backed, never auto-escalate past local
   tiers)." The terminal's job is *intent in, capability out* — it must **not** quietly
   choose a hosted model. `hostedTransmission` is explicit-only. Keep that.
3. **Trust.** "Send plain text" sounds frictionless, but the wedge is
   `intent → capability → visible result → proof`. Every terminal line should end in an
   object + a receipt the canvas can show (and `hii.terminal.observe` / proof surfaces can
   replay). No silent runs.
4. **Scope.** Is the terminal *global* (acts over the whole canvas/world) or *contextual*
   (acts on the current selection / current scene)? Contextual seems right — `contextNodeIds`
   already carries up to 100 selected nodes.
5. **Voice + text same wire.** The wedge says text *or voice* intent. Is voice just a
   transcription into the same plain-text terminal, or a separate lane?

> Your thoughts:

---

## 6. Decisions the two layers share (call out early)

- **One object model, many projections.** Canvas and terminal both touch the operational
  graph; projections (Space touch surface, contact sheet) are capability subsets, not new
  stores. Reaffirm `docs/SPACES_ARCHITECTURE.md` §0 and "no third source of truth."
- **Local-first, operator-controlled.** Terminal execution stays local-only until a hardened
  remote runner exists (AGENTS.md). Files-on-disk → node mapping should be *governed*
  (owner/status/audit), per the object model.
- **Cost discipline.** Terminal → router must prefer local tiers; nothing escalates on its own.

---

## 7. What I still need to say (queue)

- [ ] Pick the primary organizational unit: scene vs folder vs tag.
- [ ] Pick terminal *form* (node / bar / participant) and default.
- [ ] List the *minimum real viewers* (which file types must be real, not metadata).
- [ ] Decide flat vs nested organization.
- [ ] Confirm terminal = local-only execution with on-canvas proof.
- [ ] Confirm voice = same plain-text wire as text.

---

## 8. Receipts / proof to attach later
- Cite the code lines above when this becomes a `docs/` ADP.
- If any viewer/terminal behavior is built, prove it with a rendered-frame unit test or a
  rendered escape-sequence test, not a pty drive (AGENTS.md CLI discipline).
