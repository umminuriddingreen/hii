# HII agentic environment audit and launch system

Date: 2026-07-30

Status: founder working document. Verified product facts and proposals are kept
separate. Nothing in the launch copy should outrun a live demo.

## The conclusion

HII should not compete to be the loudest general-purpose agent. Its credible
wedge is a spatial workspace where a person can point to context, state intent,
approve bounded work, inspect the resulting artifact, and keep a human-readable
receipt that can become a reusable capability.

The public sentence:

> HII is a workspace where your ideas, files, tools, and agents become finished
> work you can inspect and keep.

The product shorthand:

> Intent in. Receipt out.

The internal maturity test:

> A new user can bring in messy source material, give one bounded intent, watch
> real work happen, inspect and edit the result, understand the proof, and repeat
> the capability later without rebuilding the context.

“Infinite” should mean that the workspace can grow without the person losing
orientation, authorship, or trust. It should not mean an unbounded agent loop.

## Verified implementation checkpoint

The first governed spatial-run loop is now real rather than a roadmap claim.
Live HII Space completed this exact sequence:

1. Select a canvas object as context.
2. State an intent and prepare, but do not start, a run.
3. Review the selected context, capability, eight-step budget, workspace write
   boundary, and external-action boundary.
4. Explicitly approve the AII `workspace.run`.
5. Run one flat HII verification action and preserve its real output.
6. Return a structured receipt and materialize connected artifact and receipt
   objects on the canvas.
7. Convert the verified trace into a proof-backed capability draft that still
   requires operator review.

The live proof is
`/Users/ummi/.hii/runs/cli/19fb352a74f-e7d9/receipt.json`; the implementation
commit is `53a70ca`. Full local CI passed: 105 web tests, 85 Rust tests, clippy,
all product smoke suites including the new spatial-run gate, and the production
build.

This closes “one legible governed run,” the first capability-draft path,
installed-model truth, and the bounded run stop/retry/reconciliation path. It
does not close the entire maturity matrix. The highest remaining product gates
are image/native creative artifact adapters, clean-machine onboarding,
packaged-app recovery, and media organization at scale.

### Verified lifecycle checkpoint

The next maturity slice closed the lifecycle gaps that could turn a governed
run into a dead end:

- Approval now discovers the models actually installed in Ollama. The live Mac
  exposes only `qwen3.6:35b-mlx`, so HII no longer offers the absent 27B model.
- Stop is an append-only `workspace.cancel` request. AII owns the process,
  persists its PID, terminates only the matching bounded workspace runner, and
  records cancellation as a terminal receipt state.
- A late child-process callback cannot overwrite cancellation.
- A running job left behind by an interrupted daemon is reconciled from its
  owned-process state and verified receipt instead of remaining “running”
  forever.
- Failed and cancelled cards explain that their authority has ended. Retry
  creates a fresh proposal and therefore requires fresh approval.

The isolated lifecycle product gate proves owned PID termination, idempotent
cancellation, callback-race safety, and interrupted-run reconciliation. Live
HII Space proves the installed-model approval control and the fresh-retry
interaction. Full local CI now passes 106 web tests, 89 Rust tests, clippy,
every product smoke suite, and the production build.

This closes governed cancellation/retry and installed-model discovery. Recovery
is now deterministic for the daemon/job boundary, while packaged-app crash and
upgrade recovery remain clean-machine release gates.

### Verified artifact checkpoint

HII now returns each text or code file named in a completed run receipt as its
own editable canvas object beside the run. This is the first artifact-first
adapter, not a generic summary pretending to be the output.

The boundary remains proof-backed:

- The artifact must be named in the completed run's immutable receipt.
- The resolved file must remain inside that run's approved workspace root.
- Symlink escapes and unlisted paths are rejected.
- Saves are atomic and require the revision hash that was opened, preventing a
  stale canvas from overwriting newer filesystem work.
- A human edit does not rewrite the agent receipt. HII appends a separate
  `workspace.artifact.edited` receipt and attaches its id to the canvas
  object's audit history.
- Unsupported binary/native files remain source-linked and open in their native
  Mac app rather than being forced into a fake universal editor.

The isolated spatial-run proof covers read, edit, stale-write conflict,
unlisted-path rejection, symlink-boundary rejection, and durable human-edit
provenance. Markdown, text, code, structured data, SVG, and other bounded UTF-8
formats are supported up to 2 MB. Image, drawing, model, and richer native-file
adapters remain the next artifact layer.

### Verified runtime-health checkpoint

HII Space no longer displays a raw `hiid 44` count. That number mixed one real
daemon, historical terminal run records, and observed workstation processes,
so it looked like dozens of active agents when there were none.

The shared health model now reports one operator-facing state:

- `AII ready` when the owned daemon heartbeat is fresh and no approved work is
  active.
- `AII working` when approved runs are active or queued.
- `AII needs attention` when the heartbeat is stale or a recent daemon error
  needs recovery.
- `AII offline` when approved local work cannot start.

Only attention and offline states offer recovery actions, and those actions are
explicit local Start or Restart buttons. The expanded panel shows active and
queued run counts, heartbeat age, and explains that observed Mac processes are
inspectable context rather than active HII agents. Historical failed runs do
not degrade current runtime health.

## Evidence reviewed

### Live HII

- The Svelte workspace is a real spatial canvas with persisted image, surface,
  intent, run, link, terminal, chat, board, and browser objects.
- The default live workspace inspected during this audit contained 182 objects,
  including 164 images. HII can hold substantial context, but the flat media
  field overwhelms the more meaningful work.
- Intent-to-run links, local persistence, knowledge search, provenance,
  approval semantics, receipts, terminal/browser/model surfaces, and product
  smoke tests exist.
- Chat and terminal surfaces expose too much raw operational output. The board
  also showed duplicate or low-quality generated tasks.
- Runtime state is hard to interpret: the surface showed roughly 90 `hiid`
  instances without explaining whether that was healthy or actionable.
- `hii space health`, `hii space snapshot`, and `hii space apps` hung without
  useful output during the audit. The compatibility-safe `hii health --text`
  and `hii caps show` entrypoints worked.
- This audit added a spatial Map with object inventory and direct navigation,
  plus an off-screen rescue action when the workspace is outside the viewport.

### Arry conversation

The useful signal was not feature demand. It was audience and communication
clarity:

- HII is one environment for moving from an idea to digital and physical work
  without scattering attention across windows and disconnected context.
- The initial audience is creative people who make digital or physical assets,
  not “everyone.”
- Early community work should materially benefit creative Black makers through
  access, paid participation, credit, and whose work is featured.
- Avoid Adobe-style extractive subscription behavior.
- Arry found the HII explanation more descriptive and concise than Clicky, but
  kept asking for the concrete next step. Every public surface therefore needs
  one obvious action.

Private message text is intentionally not reproduced here.

### Recent Claude feedback

Claude’s strongest positive read was the canvas/node model, intent-to-linked-run
flow, terminal/browser/model panes, and persistence. Its repeated criticism was
equally useful: a blank or lost viewport is fatal, the large image grid becomes
flat noise, raw error output is not actionable, and product routes had grown
beyond the spatial wedge. Recent work already narrowed HII back to the spatial
workspace; the next step is to make that workspace legible under real load.

### Current product comparisons

| Product | What it teaches HII | What HII should not copy |
| --- | --- | --- |
| Hey Clicky | One memorable interaction, immediate value, personality, and demos understandable with sound off | A buddy overlay, screen surveillance posture, or subscription-shaped dependence |
| Figma | Direct manipulation, inspectable/editable output, versions, point-and-edit, reusable skills, and a tight canvas-to-code loop | Design-tool feature parity or pretending every artifact belongs in one editor |
| Miro | Frames, templates, overview navigation, and collaboration conventions for large canvases | A passive whiteboard where execution and proof live elsewhere |
| Apple Freeform | Native simplicity and Scenes that turn a large board into navigable moments | A generic board with no governed agent state |
| Cursor | “Demos, not diffs,” rapid visible product cadence, and specific user outcomes | Speed claims without measurement or coding-only positioning |
| OpenClaw | Community proof, a recognizable point of view, and concrete workflows people can reproduce | “Does everything” autonomy claims or personality replacing trust |

HII’s signature remains: the canvas is not only where work is discussed. It
holds the governed state of the work—intent, selected context, boundaries,
run, artifact, proof, receipt, and reusable capability.

## Initial customer

Primary:

> An independent multidisciplinary maker on Mac—a designer, architect, creative
> technologist, or adjacent builder—who moves among visual references, code,
> documents, local tools, and physical or digital outputs, and is accountable
> for the result.

Job to be done:

> When a project becomes a messy multi-tool collection, help me hand off one
> specific part without losing why I asked, what context I selected, what the
> agent touched, and what came back—so I can edit the result, explain it later,
> and reuse the working setup.

Secondary only after the solo loop is excellent:

- Tiny multidisciplinary studios.
- Design and architecture educators and students.
- AEC and fabrication makers with repeatable, inspectable handoffs.

Do not lead with enterprise teams, a plugin marketplace, a social network,
cloud sync, credits, or a general “AI operating system.”

## Maturity gap matrix

| Priority | Gap | Evidence of done |
| --- | --- | --- |
| 0 | Orientation at scale | A user can always answer where they are, what exists, and how to return. Map, frames/Scenes, search, and off-screen rescue work with hundreds of objects. |
| 0 | One legible governed run | Selected context, intent, permission boundary, progress, artifact, proof, and receipt are visible as one connected flow without reading raw logs. |
| 0 | Artifact-first closure | The output opens beside its inputs, is editable or launches its native editor, and reports exactly what changed. |
| 0 | Trustworthy context selection | Before approval, the user can see the exact files/nodes/sources included, exclusions, provenance, and likely network boundary. |
| 0 | Human-readable runtime health | One instance model, one clear status, failures with cause and recovery action, no unexplained process counts. |
| 1 | Media organization | Imports become stacks, frames, or contact sheets rather than hundreds of equal-weight image nodes. Batch labeling and dedupe are visible. |
| 1 | Run focus and log hygiene | Default progress is a short step list; raw stdout/stderr stays one level deeper. Duplicate tasks and transcript debris are prevented. |
| 1 | Capability reuse | A successful approved trace can become a draft capability, show required inputs and permissions, and be re-run on new context. |
| 1 | Onboarding | A clean Mac install reaches the first verified artifact in under ten minutes with no repository knowledge. |
| 1 | Recovery | Interrupted runs, stale surfaces, conflicting writes, and app restarts recover without duplicate work or lost provenance. |
| 2 | Collaboration | Share/export a bounded workspace bundle with redaction, provenance, and receipts before adding live multi-user editing. |
| 2 | Extensibility | Add governed adapters only after the local knowledge and run loop is reliable; no marketplace before the trust model is proven. |

## Build now / Build next / Later

### Build now

1. Finish the hero loop as a single product path:
   context selection → intent → approval → compact progress → visible artifact →
   receipt → save as draft capability.
2. Make the Map permanent product infrastructure and add named frames/Scenes.
3. Replace raw chat/run noise with an inspectable progress summary and a
   deliberately secondary log view.
4. Make runtime health describe one operator-meaningful state and recovery
   action. Fix the hanging `hii space` commands.
5. Build one real demo workspace with fewer than eight visible semantic nodes
   and real latency. No mock output.
6. Treat the new CI product-proof job as the minimum merge gate.

### Build next

1. Contact-sheet import, stacking, dedupe, and “organize into frames.”
2. Exact context preview with secrets/network warnings before approval.
3. Artifact adapters for the first audience: Markdown, image/reference board,
   code/site preview, and a native-file handoff.
4. Capability draft, review, replay, and diff against the previous run.
5. Clean-machine packaged-app test and upgrade/recovery test.
6. A first paid design-partner cohort whose work, feedback, and attribution are
   visible in product decisions.

### Later

- Live multi-user collaboration.
- Cloud sync.
- Plugin marketplace.
- Creator economy, credits expansion, or decentralized compute.
- Broad enterprise controls.
- Any claim of unattended or unbounded autonomy.

## The first hero demo

One continuous 45-second recording. No cuts, speedups, or mock state.

| Time | On screen | Caption |
| --- | --- | --- |
| 0–3s | A calm canvas with one reference image, one folder, and one prior run | “This is a real project on my Mac.” |
| 3–8s | Lasso the image and folder; the intent entry appears beside the selection | “I choose the context.” |
| 8–14s | Type: “Generate an elevation study from these references and save it in studies.” | “One intent.” |
| 14–20s | Intent and pending Run nodes appear. Approval shows tool, target path, write scope, and network boundary | “The boundary is visible before anything runs.” |
| 20–23s | Click Approve | “Approve.” |
| 23–32s | Compact steps tick: read references → generate study → write files → verify output | “It works where I can see it.” |
| 32–38s | The actual study appears as an Artifact node and opens beside the sources | “The result stays with the work.” |
| 38–43s | Open the receipt: intent, named inputs, approval, tool/model, files changed, verification, duration | “Every run leaves proof.” |
| 43–45s | Save as draft capability; it becomes a reusable tile | “Intent in. Receipt out.” |

Do not shoot this until every beat is real. If a beat is not implemented, the
correct move is to build it or remove it—not to simulate it.

## Three supporting demos

### It gets big. That is why there is a Map.

Open on a genuinely dense month of work. Show the confusion for two seconds,
open Map, inspect type counts and named frames, click one frame, and fly to it.
This turns a real weakness into a credible design response.

### Where did this come from?

Start from an older artifact and walk backward through its receipt: artifact →
run → intent → exact sources → approval. End on the original intent. The hook:
“Six weeks later, I can still answer why this looks like this.”

### The second time becomes a tool

Show the original successful run collapsing into a draft capability. Drag it
onto new inputs, inspect the changed boundary, approve, and compare the new
artifact with the prior one. The hook: “Work you do once becomes a tool you
keep.”

## Ten-post X launch thread

1. I built HII because I kept losing the thread—not the file, the why. HII is a
   local-first spatial workspace for bounded agent work. Intent in. Receipt out.
   [hero demo]
2. You select context. You state intent. You approve the boundary. It runs and
   leaves a receipt. No step is meant to disappear.
3. “Select context” is literal. Point at the references, files, and earlier work
   that matter instead of hoping a chat guessed correctly.
4. Before a run starts, HII shows the tool, path, scope, and network boundary.
   Approval is one click, but the boundary remains part of the work.
5. The result lands beside its inputs as an artifact you can open and change—not
   a promise that something was saved somewhere.
6. The receipt keeps the intent, named inputs, approval, files changed, proof,
   and duration in one human-readable place. [provenance demo]
7. A good approved run can become a draft capability. The setup you did once
   becomes something you can inspect and use again. [reuse demo]
8. HII is local-first. Persistence and search are local; network-using surfaces
   are named before use. Ownership is architecture, not a privacy slogan.
9. HII is not a chatbot, buddy overlay, social network, or magical autonomous
   everything app. It is one interface where humans and agents work in a
   meaningful way, with human intent and ownership intact.
10. It is early. Big canvases still need better organization and onboarding
    needs work. I am building the next version with a small paid group of
    multidisciplinary makers. [one application link]

## Five standalone posts

1. The hardest HII problem is not agents. It is that three months of visual work
   can look like a crime board. So I built a Map: inventory, frames, and a way
   home. Density is the cost of keeping context. Navigation is the answer.
2. Ask why an AI made a decision six weeks later and most tools give you a new
   guess. HII keeps the original intent, selected inputs, boundary, output, and
   proof together.
3. “Autonomous” often means nobody can tell what it touched. A HII run declares
   its boundary before it starts. Bounded work is a feature.
4. Direct manipulation keeps the person as author. The agent can produce a
   draft; the artifact must remain something you can point at, edit, and own.
5. Chat gave me transcripts. I wanted yesterday’s good work to become today’s
   inspectable tool. That is what a HII capability is for.

## Four-week publishing cadence

### Week 1: make the loop understandable

- Publish the hero demo and launch thread.
- Publish the approval-boundary clip.
- Reply to serious questions with a real clip or “not yet.”

Success test: a stranger can restate the loop in one sentence.

### Week 2: establish the wedge

- Publish “Where did this come from?”
- Publish the honest Map weakness/fix post.

Success test: viewers associate HII with visible context, bounded work, and
receipts rather than a generic canvas.

### Week 3: community proof

- Feature a paid design partner’s real project with their name and work first,
  HII second.
- Show one capability created from that workflow with explicit credit.

Success test: HII is demonstrated by people making real things, not only founder
claims.

### Week 4: show judgment and reopen the door

- Publish one mistake and before/after design decision.
- Publish the direct-manipulation clip.
- Open a capped cohort with one clear action and a public next-month focus.

Success test: attention converts into a small, appropriate design-partner group.

## Claims red team

Do not claim:

- Fully autonomous, “it just handles it,” or an infinite unbounded agent.
- Nothing ever leaves the machine. Some tools, browsers, and models use the
  network. Name the boundary instead.
- HII replaces Figma, Miro, an IDE, or every creative tool.
- Compliance-grade, audit-ready, or cryptographically verified unless that
  exact guarantee exists and is defined.
- HII remembers everything about a person. It searches approved local context.
- “Built for Black creatives” as marketing texture. Prove the commitment through
  paid participation, credit, access, and whose work shapes the product.
- 10× faster or time saved without a published measurement.
- Zero setup or “just works” before the clean-machine path proves it.
- Roadmap features in present tense.
- Guaranteed virality.

## CI/CD decision

The repository now has four explicit local CI stages:

1. Web type and unit tests.
2. Rust formatting, tests, and clippy.
3. HII product-proof gates for SDK, skills, knowledge, knowledge runs, Context
   Dock, activation, window state, workspace durability, and bootstrap syntax.
4. Production build.

This is CI, not external delivery. HII remains local-first and this audit does
not authorize deployment, upload, or release. The next CD layer should package
an immutable Mac build, test it in a clean temporary user environment, verify
upgrade/recovery and receipt compatibility, then produce a signed local release
candidate for explicit operator approval. Publishing remains a separate action.

## Sources

- Hey Clicky: https://www.heyclicky.com/
- Figma Make: https://www.figma.com/make/
- Figma canvas for agents:
  https://www.figma.com/blog/the-figma-canvas-is-now-open-to-agents/
- Miro infinite canvas: https://miro.com/online-canvas-for-design/
- Apple Freeform: https://support.apple.com/guide/freeform/welcome/mac
- Cursor product writing: https://cursor.com/blog
- OpenClaw: https://openclaw.ai/

## Immediate acceptance test

The next product milestone is complete only when a first-time observer can watch
the 45-second hero demo and correctly answer:

1. What context did the person select?
2. What did the person ask for?
3. What was the agent allowed to do?
4. What real artifact changed?
5. What proof remained?
6. How would the person reuse the work?

If any answer requires a voiceover explanation, the product path is not mature
enough yet.
