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

### Verified run-focus checkpoint

Governed run cards now lead with one five-step lifecycle: intent approved,
accepted by AII, bounded work, proof collected, and receipt returned. Each step
is derived from the real job ledger, timestamps, proof records, checks, and
receipt. Raw execution text is not used as agent “thinking” or as the primary
progress surface.

Evidence is progressively disclosed in two deliberate layers. `Inspect
evidence` opens verification, proof records, duration, and the decision trail.
`Raw execution log` is a second nested control and remains closed by default.
Failed and cancelled historical runs receive a human-readable terminal summary;
their persisted raw final line is available only inside evidence. A transient
failure before a job exists can still show its immediate diagnostic so the user
is not left with a generic dead end.

The isolated run-focus unit and product gates prove the lifecycle mapping,
terminal summaries, evidence limits, and raw-log hierarchy. Live HII Space in
`governed-run-demo` proved all five completed states, a verified receipt with
one passing check, the closed evidence default, the opened evidence layer, and
the separately opened raw log. The live pass also found and fixed canvas drag
interference on the disclosures.

The same live workspace exposed an important demo-quality gap: later proposal
nodes overlap the completed run, so Map can focus the correct object while a
higher node still obscures it. This does not invalidate the DOM and interaction
proof, but it is not launch-grade choreography. The viral demo should use a
small isolated workspace or named Scene with no overlapping drafts. Duplicate
task prevention and automatic demo-layout cleanup remain open.

### Verified launch-proof checkpoint

HII now has one real, isolated launch workspace instead of a polished mock.
The approved AII run `9fa34c8a-1f4c-4228-9160-78a78c668937` used three named
context objects and the installed `qwen3.6:35b-mlx` model to write and verify
`docs/launch/launch-storyboard.md`. The run completed in 41.916 seconds and its
receipt is
`/Users/ummi/.hii/runs/cli/19fb3cfa8dd-e595/receipt.json`.

The persisted `launch-proof` workspace contains exactly seven semantic objects:
three sources, one intent, one completed run, one receipt-linked editable
artifact, and one receipt. All run-derived objects point to the real AII job.
Creating it did not steal the operator's current workspace selection;
`governed-run-demo` remained selected.

The generator is deliberately fail closed. Preview is the default, approval is
explicit, an existing named workspace is never replaced, and no workspace is
created without a completed receipt containing both the storyboard artifact
and a passing check. Three failed acceptance attempts therefore remained
visible in the job ledger without becoming showcase state.

Those failures exposed two real convergence defects. HII's stream guard counted
private action rehearsal together with visible JSON, and a successful verify
could be followed by repeated verification or looping final narration. The
first correction is on the current branch; the two follow-up convergence
commits are preserved on local branch `codex/hii-convergence` until concurrent
MCP work in the same Rust files lands. Together they keep private and visible
repetition histories separate, preserve a final summary that arrives just
before proof, treat an identical already passing check as completion rather
than running it again, and recover a model-summary loop only when the latest
mutation epoch already has fresh passing proof. The successful launch receipt
predates the duplicate-check guard and therefore honestly contains the same
passing check twice.

### Verified governed-capability checkpoint

The capability draft is no longer a dead-end sentence on a completed run. HII
Space now opens the live AII manifest as a governed canvas object and shows its
source-receipt lineage, permissions, side effects, and required proof before
registration. Registration requires a named reviewer and an explicit review
confirmation; a draft never grants replay authority by itself.

A registered capability exposes a separate explicit replay approval. The new
append-only execution ledger at `~/.hii/skills/executions.jsonl` joins each
replay to its fresh AII run and exact action receipt. HII does not label the
replay verified merely because a daemon job completed: the linked capability
receipt must contain passing checks. Once two replay receipts exist, the
workspace compares status, duration, output, proof, and verification counts
without rewriting either receipt.

The isolated skill-replay product gate proves draft creation from a real agent
action receipt, guarded registration, source-receipt lineage, exact
receipt-gated verification, and previous-run comparison. Live HII Space proves
the manifest review surface and its disabled-until-reviewed registration
control. A real operator-approved replay was deliberately not started during
this audit, so end-to-end replay remains a final live acceptance step rather
than a completed product claim.

### Verified execution-context checkpoint

Selected canvas objects now become an executable context manifest before a run
can be approved. HII snapshots bounded human-authored note or text content,
resolves workspace-local paths, content-hashes regular files with SHA-256,
names proof references, and distinguishes local, inline, remote, opaque, and
label-only context. The approval card shows those facts rather than presenting
node titles as if the agent can necessarily read them.

The manifest fails closed for missing files, secret-like paths,
credential-bearing URLs, unsupported filesystem objects, symlink escapes, and
local files outside the approved workspace root. Remote URLs remain visible as
references and disclose that governed outbound read-only retrieval may occur;
publishing, upload, messaging, spending, and secret export remain blocked.

Approval is bound to the reviewed manifest fingerprint. AII recomputes the
manifest immediately before queueing and rejects the run if a selected file or
snapshot changed after review. The fingerprint, content identities, snapshots,
network statement, and selected proof lineage enter the AII execution goal and
job metadata. The daemon now preserves the bounded manifest instead of
silently truncating it at the previous 4,000-character limit.

The isolated context-manifest unit and spatial-run gates prove relative and
absolute workspace files, content hashing, inline snapshots, proof lineage,
outside-root rejection, secret rejection, remote-read disclosure, and stale
review rejection.

Explicitly imported local creative assets now use immutable content-addressed
storage under the HII runtime. Selecting one for a run does not widen the
runner to `~/.hii`: the approval manifest names a deterministic disposable path
inside the already approved project root. AII reverifies the source SHA-256
immediately before execution, creates a read-only copy only for that run, and
removes only a copy carrying the matching run/fingerprint ownership marker
after completion, failure, cancellation, or interrupted-run reconciliation.
The source asset remains in HII-managed storage. Arbitrary outside-root paths
still fail closed.

The dedicated context-staging gate proves content identity, reviewed
destination, pre-execution stale-source rejection, immutable staging, guarded
cleanup, and source preservation. This closes the transport gap that made a
selected Figma export, image reference, PDF, drawing, model, audio file, or
video look usable on the canvas while remaining inaccessible to the bounded
runner.

The clean-user packaged-app gate now also uploads and deduplicates a 600 KiB
asset, then proves that the bytes survive app replacement and server restart.
The desktop server declares its exact loopback origin to SvelteKit and raises
the adapter body ceiling above HII's own 250 MiB route policy, so packaged
uploads are governed by HII instead of being rejected by an implicit framework
default before the route runs.

Live HII Space in `context-manifest-proof` shows one approved human note as an
inline snapshot, the master context as a content-hashed workspace file, and a
Figma URL as a remote reference with an outbound-read warning. All three are
visible before the untouched `Approve bounded run` control. No run was started,
and the operator's prior `governed-run-demo` workspace selection was restored
after the visual proof.

### Verified sub-asset context checkpoint

Whole-file integrity is no longer the smallest unit of human intent. Native HII
viewers now let a person preserve a PDF page or range, normalized image region,
design frame and layers, DXF view bounds and visible layers, media in/out range,
or 3D camera and target as the selected focus of that object.

The focus stays attached to the governed workspace object and enters the same
approval manifest as its source identity. Changing only the page, crop, layer,
time range, or view changes the approval fingerprint. AII carries the normalized
anchor into the read-only staged-file manifest and receives a plain-language
instruction naming the exact reviewed region; the byte boundary and external
action policy are unchanged.

The dedicated sub-asset gate proves all six anchor types, strict normalization,
fingerprint invalidation when focus changes, execution-goal instructions,
read-only staging, anchor preservation, guarded cleanup, and immutable source
preservation. Design sources and media imports are now content-addressed with
SHA-256 like the other creative assets rather than becoming metadata-only or
losing their runner integrity proof.

This follows the useful pattern in Figma selection links, Miro frames/layers,
Apple Freeform saved views, and screen-context agents without turning HII into a
generic whiteboard or hiding provenance. HII's distinct contract is that human
focus, source identity, permission boundary, verification, and receipt remain
one governed loop.

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
formats are supported up to 2 MB.

Receipt-named PNG, JPEG, GIF, WebP, AVIF, and SVG outputs now remain visible
inside the governed Artifact object rather than collapsing to a generic native
file handoff. Preview reads repeat the completed-run receipt and approved-root
checks, refuse unsupported types, cap bytes at 25 MB, and return private
no-store content. The original file and immutable run receipt remain the
authority; HII does not copy or silently rewrite the image. Drawing, model, and
richer native-file adapters remain the next artifact layer.

Receipt-named HTML now opens in the same Artifact object with explicit
`Preview` and `Edit` modes. Preview is deliberately static: the iframe is
sandboxed, its response blocks scripts, forms, navigation, and all network
loads by default, and only inline styling plus data images/fonts are allowed.
This gives creative technologists visual feedback without silently converting
a completed local artifact into new execution or outbound authority. Saving
still uses the existing optimistic revision check and appends a separate human
edit receipt.

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

The separate desktop-space inspection path is now deterministic too.
`hii space health` is routed through the compatibility CLI rather than being
misclassified as an agent goal. AeroSpace subprocesses have a three-second
timeout, and the current Mac returns its truthful installed-but-offline state
in about 60 ms with `open -a AeroSpace` as the explicit next command. HII does
not launch AeroSpace or move windows implicitly. Snapshot and app inspection
stop at the same health boundary when the server is unavailable.

### Verified Scenes checkpoint

HII now turns its existing spatial frames into named, ordered Scenes without
introducing a parallel presentation system. A Scene is a persisted HII spatial
object owned by the human. Its captured membership remains an explicit
`frameId` relationship in the workspace document, while its Map entry shows a
compact type summary rather than a screenshot thumbnail that can drift from
the real canvas.

- New Scenes receive a stable sequence number and human-editable name.
- Capture records which fully contained objects belong to the Scene.
- Go deterministically fits the Scene and its current members.
- Previous and next navigation wraps through the ordered Scene sequence.
- Existing frames remain readable and are treated as legacy Scenes rather than
  requiring a destructive workspace migration.
- Scene creation and membership capture add human-authored audit entries.

The isolated `hii:scenes:check` product gate proves ordering, wrapping
navigation, explicit membership, exact-selection organization at 240 objects,
type summaries, deterministic viewport framing, and persistence after reload.
This closes the named Scenes and explicit existing-object organization portions
of orientation at scale. Stacking and reviewed near-duplicate handling remain
open.

### Verified governed-outline and first-win checkpoint

Map is now a searchable governed outline rather than a shallow list of recent
places. It includes every framed and unframed object, preserves arbitrary-depth
parent lineage, groups work under ordered Scenes or `Loose objects`, summarizes
terminal and approval states, and keeps matching ancestors visible when a
person searches for a descendant. Missing or cyclic parent references degrade
to navigable roots instead of hiding work or breaking the outline.

Live HII Space proved this against the existing `governed-run-demo` workspace:
the outline indexed 16 unframed objects and a search for `receipt` exposed the
actual intent → run → receipt lineage, including the completed run and verified
receipt. This is the useful lesson from Figma layers, Miro frames, and Apple
Freeform Scenes, adapted to HII's own contract: the hierarchy carries governed
agent state and proof rather than only visual grouping.

The activation path now preserves an equally inspectable first-session journey:
local agents detected → project context previewed → context explicitly approved
→ bounded run started → verified receipt returned (or run failed). Events are
append-only, duplicate-safe, terminal-state immutable, and restricted to
opaque ids plus bounded counts, sizes, agent kind, run kind, and timestamps.
Paths, task text, identities, model output, and file contents are not recorded.
The aggregate funnel is local-only and exposes no raw event rows.

The live activation mock reached all five milestones and rendered the verified
receipt journey in 42 seconds. The isolated activation gate proves the real
append-only event store, privacy boundary, idempotence, terminal immutability,
completion rate, and median time-to-receipt aggregation. The current local
funnel correctly reports zero real journeys; HII will not manufacture founder
cohort evidence from demo state.

### Verified contact-sheet checkpoint

New multi-image imports no longer become one equal-weight canvas node per file.
When a batch contains four or more images, HII hashes the files locally,
omits exact byte duplicates before storage, and creates bounded contact sheets
of at most 80 references each. Every visible thumbnail retains its source name,
local asset route, local path, size, and SHA-256 proof where persistence
succeeds. Mixed non-image files remain independent editable or native-linked
objects.

The isolated `hii:media:check` proves grouping, pre-storage exact dedupe,
source proof, and mixed-batch behavior. The unit gate additionally proves that
the 164-image case observed in the live workspace becomes three sheets of
80, 80, and 4 without dropping a unique source.

The live `maturity-proof` workspace adds a visual checkpoint. One persisted
Scene named `Launch proof` contains one contact sheet with five real HII launch
references, five distinct local asset routes, and five source names. Reload
preserves the Scene and media, `Map 1` reports `2 objects · 1 scene`, and its
Scene entry navigates back to the framed work while AII remains ready. This
review also caught a real presentation defect: wide references were square
cropped. Contact sheets now use a contained 16:9 treatment so each composition
and its copy remain legible.

Chrome's extension could not grant the native file chooser access during this
audit because “Allow access to file URLs” was disabled. The five files were
therefore persisted through HII's same local workspace and asset APIs, while
the isolated import gate—not this browser step—proves chooser-to-contact-sheet
batch behavior. That distinction keeps the visual and import claims separate.

This is intentionally non-destructive. Existing flat image fields are not
silently rewritten, and near-duplicate visual matching is not claimed. A
future stacking action and perceptual-deduplication review remain open.

Contact sheets are now also direct context surfaces rather than terminal
collages. A person can select up to twelve exact thumbnails, optionally label
the role of each image, and hand the sheet to the normal intent composer. HII
expands only those reviewed choices into separate run-context entries with
their own local path, SHA-256 identity, annotation, and proof lineage. The
approval fingerprint therefore changes with the exact selected references;
unselected images do not silently enter the run.

Human classification now survives beyond the immediate selection. A person
can apply one bounded label to the selected references, filter the sheet by
name, local path, media type, or those durable labels, and select the visible
result without expanding approval beyond twelve images. Labels remain attached
to each source hash when the context selection is cleared, and they reappear
in the exact run-context annotation when that source is selected again. This
adds the useful batch organization learned from Figma, Miro, and Freeform
without turning AI guesses into silent project structure.

Any selected thumbnail can now be promoted beside its sheet as an ordinary HII
image object. Promotion is idempotent for the sheet plus source hash, retains a
parent link to the sheet and the exact SHA-256 proof, chooses an open canvas
lane, and immediately exposes the existing `Focus region` interaction. The
resulting normalized region follows the already verified fingerprint,
read-only staging, and stale-review rules. This reuses HII's image object and
governed context loop rather than creating a second contact-sheet crop tool.

### Verified exact-selection organization checkpoint

Map search now acts as a human-reviewed organization boundary. A person can
filter the complete governed outline, select every shown result, and choose
`Make Scene`. HII creates one human-owned Scene with the exact selected
membership; it does not move, merge, delete, or flatten the source objects.
The result is immediately reversible through the visible Undo action or
`⌘Z`.

The live `orientation-scale-proof` workspace was cloned from the default
workspace so the source stayed untouched. Searching for `asset` returned all
164 real image objects, `Select 164` made that bounded result set explicit,
and `Make Scene` produced one 164-member Scene. Map reported `183 objects · 1
scenes`; the Scene summary reported `164 image` and `164 ready`. Undo restored
the 182-object, zero-Scene state, and redo restored the Scene. The proof
workspace persisted at revision 4, and the previously selected
`governed-run-demo` workspace was restored afterward.

### Verified managed-chat focus checkpoint

The governed Run object already presents approval, queue, bounded work, proof,
and receipt as a five-step lifecycle, with evidence one level deeper and raw
execution logs behind a second explicit disclosure. The remaining live defect
was the older Chat object: two completed messages in the default workspace
still rendered 1,874- and 55,936-character Codex startup, authentication, and
tool transcripts as if they were assistant answers.

HII now extracts the readable assistant response for those legacy messages
without rewriting their stored evidence. Each message shows the human-facing
AII state and an `Inspect run details` action. The raw transcript is absent
from the default DOM and appears only while that disclosure is open. Live HII
proved both old messages readable, the raw marker hidden by default, and the
preserved transcript available on inspection. `hii:chat:check` makes that
compatibility boundary part of the permanent product CI gate.

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
- Managed Run and legacy Chat surfaces now keep readable progress or assistant
  output primary and raw execution evidence explicitly nested. The terminal is
  still intentionally raw. The board now records human, agent, and system
  origin; holds generated active requests as proposals; rejects exact open
  duplicates before append; and requires explicit approval before a proposal
  enters `next` or `doing`. An approved active card can now prepare the existing
  bounded HII Space run with a content fingerprint and a second execution
  approval; queued, running, blocked, completed, and receipt-linked state then
  return to the same append-only board ledger. The authority now rejects
  illegal lifecycle jumps, repeated state writes, receipt replacement, and
  completion without proof; failed or cancelled cards expose a fresh-run retry
  path rather than silently reusing the old run.
- Runtime state is hard to interpret: the surface showed roughly 90 `hiid`
  instances without explaining whether that was healthy or actionable.
- During the initial audit, `hii space health`, `hii space snapshot`, and
  `hii space apps` were misrouted into an agent loop and hung. The repaired
  deterministic command family now reports that AeroSpace is installed but
  its server is offline; ready-state snapshots remain product-smoke verified
  but cannot be live-verified until the operator starts AeroSpace.
- This audit added a searchable governed outline with complete object
  inventory, Scene and lineage navigation, status summaries, and an off-screen
  rescue action when the workspace is outside the viewport.

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

### Opus 5 launch collaboration

Claude Opus 5 reviewed the verified product state and proposed a 42-second
context → boundary → lifecycle → artifact → receipt demo. Its most useful
product critique matched the live inspection: a special clean recording Scene
is not enough if normal follow-up and result placement can still obscure prior
work. HII now raises a Map-focused object above overlapping nodes and places new
run/result groups in the nearest open lane.

The external critique was treated as input, not product truth. Its unsupported
scroll-to-enable approval behavior, per-tool approval claim, guaranteed partial
artifact after cancellation, and continuous 42-second timing were removed. The
vetted working copy is `docs/launch/hii-x-launch-kit-opus5.md`. It keeps one
first-cohort action, one honest labeled time jump when the local model takes
longer than the published cut, and a claim table tied to current proof.

A second read-only `claude-opus-5` collaboration used the primary Arry findings
and the newly verified sub-asset anchor contract. It found a sharper cold-open:
change a selected image region or design layer and show the approval fingerprint
change before execution. Auditing that proposal exposed a real stale-context
gap: pending runs retained their original anchor snapshot even when the source
object changed. HII now rebinds edited source context only into unapproved runs
and their intent, clears the stale preview, and recomputes the manifest.
Queued and completed runs remain immutable. The vetted production brief is
`docs/launch/hii-fingerprint-test-opus5.md`; unsupported zero-latency execution,
crop handles, design-layer toggles, source-node hash badges, and public-download
claims were removed.

A third read-only `claude-opus-5` collaboration reviewed the newly verified
governed board boundary in session
`316086a5-c3b8-4ccf-91c7-f1857b1c64a6`. Opus returned `revise`: the product
mechanic was strong, but “refused” overstated a lane rule, duplicate rejection
needed a visible count, and the clip needed to end on a concrete maker question
instead of a slogan. The production brief is
`docs/launch/hii-governed-proposals-opus5.md`. It states only the literal
proposal, exact-open-duplicate, and recorded-approval behavior, and CI checks
the six-beat storyboard, post length, session provenance, and forbidden claims.

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
| 0 | Orientation at scale | The searchable governed outline, named ordered Scenes, arbitrary-depth lineage, status summaries, off-screen rescue, deterministic Scene navigation, and exact filter → selection → Scene flow are implemented. The 240-object product gate and live 164-image proof demonstrate organization under hundreds-of-object load; the next scale proof is useful multi-Scene classification rather than one large Scene. |
| 0 | One legible governed run | Selected context, intent, permission boundary, progress, artifact, proof, and receipt are visible as one connected flow without reading raw logs. |
| 0 | Artifact-first closure | The output opens beside its inputs, is editable or launches its native editor, and reports exactly what changed. |
| 0 | Trustworthy context selection | Before approval, the user can see the exact files/nodes/sources and sub-asset regions included, exclusions, provenance, content identity, and likely network boundary. |
| 0 | Human-readable runtime health | One instance model, one clear status, failures with cause and recovery action, no unexplained process counts. |
| 1 | Media organization | New multi-image imports become bounded proof-linked contact sheets, exact duplicates are visibly counted, selected references accept durable filterable batch labels, and filtered existing nodes become an exact reversible Scene. Stacking and reviewed perceptual dedupe remain open. |
| 1 | Run focus and log hygiene | Governed Runs use a five-step progress summary, raw logs require two disclosures, and legacy Chat transcripts render only the readable response by default while preserving inspectable evidence. Preventing duplicate or low-quality generated board tasks remains open. |
| 1 | Capability reuse | A successful approved trace can become a draft capability, show required inputs and permissions, and be re-run on new context. |
| 1 | Onboarding | The first-session journey and privacy-safe local funnel are implemented. A clean Mac install must still reach the first verified artifact in under ten minutes with no repository knowledge. |
| 1 | Recovery | Interrupted runs, stale surfaces, conflicting writes, and app restarts recover without duplicate work or lost provenance. |
| 2 | Collaboration | Share/export a bounded workspace bundle with redaction, provenance, and receipts before adding live multi-user editing. |
| 2 | Extensibility | Add governed adapters only after the local knowledge and run loop is reliable; no marketplace before the trust model is proven. |

## Build now / Build next / Later

### Build now

1. Finish the hero loop as a single product path:
   context selection → intent → approval → compact progress → visible artifact →
   receipt → save as draft capability.
2. Keep the Map and named Scenes as permanent product infrastructure. The
   searchable outline, 240-object product gate, and live 164-image reversible
   Scene proof are complete; next prove a useful human classification into
   several named Scenes without losing provenance.
3. Preserve the verified Run and Chat focus hierarchy; next prevent duplicate
   or low-quality generated board tasks from becoming active work.
4. Keep runtime and desktop-space health operator-readable; live-verify the
   repaired Space snapshot when AeroSpace is intentionally started.
5. Keep the verified seven-object `launch-proof` workspace as the launch
   baseline. Re-record it when the hero artifact changes; never replace it with
   mock output.
6. Treat the new CI product-proof job as the minimum merge gate.
7. Use the local first-win funnel with the first five founder users. Improve the
   largest real drop-off without adding external analytics or collecting task
   content.

### Build next

1. Extend the verified contact-sheet and exact-selection organization flow
   with stacking and reviewed perceptual dedupe. Durable filterable batch
   labels are implemented without weakening the exact-context bound.
2. Keep contact-sheet selection and promotion reliable at real-project scale.
   Exact sheet items, optional labels, local paths, hashes, proof lineage, and
   promoted per-thumbnail image-region focus now enter approval without
   expanding the run to every image. PDF ranges, single-image regions, design
   frame/layer, drawing view/layer, media ranges, and 3D views are implemented
   and fingerprint-bound.
3. Artifact adapters for the first audience: Markdown, image/reference board,
   code/site preview, and a native-file handoff.
4. Run one real operator-approved registered-capability replay, then preserve
   its exact receipt and previous-run diff as the launch acceptance proof. The
   workspace review, guarded registration, replay ledger, and comparison
   contract are implemented.
5. Genuine downloaded/quarantined second-Mac test. The same-Mac isolated-user
   packaged-app gate now proves embedded runtime startup, receipt persistence
   across reinstall/restart, corrupt-workspace recovery, and strict ad-hoc
   signature integrity.
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

One 45-second recording built from a real approved run. No mock state. If local
model latency exceeds the cut, use one visible, labeled elapsed-time jump rather
than implying the work was instant.

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

The repository now has five explicit local CI stages:

1. Web type and unit tests.
2. Rust formatting, tests, and clippy.
3. An optimized Rust release build, so green source cannot leave the installed
   HII command on an older binary.
4. HII product-proof gates for SDK, skills, governed skill replay, knowledge,
   knowledge runs, Context Dock, activation, window state, workspace
   durability, and bootstrap syntax.
5. Production web build.

The global launcher now has one versioned source, one atomic installer, and a
behavioral gate. It rebuilds the release CLI when the binary is missing or its
committed Rust inputs changed, reuses a fresh binary without invoking Cargo,
and preserves the last successful release while multi-agent Rust work is
uncommitted. This closes the stale-local-command failure observed after the
Space repair without making HII unavailable during partial edits.

This is CI, not external delivery. HII remains local-first and this audit does
not authorize deployment, upload, or release. The local release-candidate gate
now packages `HII.app`, copies it outside the repository, starts an empty
isolated user runtime, verifies asset and receipt persistence across reinstall
and restart, preserves a corrupt workspace for recovery, and checks the app's
strict ad-hoc signature. The public release path also requires package,
lockfile, and desktop bundle versions to agree; refuses a dirty Git worktree;
and records the exact clean commit in the final archive manifest.

External delivery remains separately gated on a Developer ID identity, Apple
notarization, explicit operator approval, and a genuinely downloaded,
quarantined second-Mac test. Publishing remains a separate action.

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
