# HII Cross-Chat Product Synthesis

**Date:** 2026-08-18
**Status:** Founder-direction synthesis; implementation claims remain subject to
current proof
**Scope:** HII discussions recovered from ChatGPT chats, Codex tasks, retained
HII memory, and the current repository documentation

## Why this record exists

HII has been discussed across product strategy, voice conversations, design
sessions, implementation tasks, and runtime debugging. Those conversations are
consistent at the center but use different names around the edges. This record
consolidates the durable product decisions without pretending that every idea
is already implemented.

Use this status vocabulary:

- **Direction** means a founder-level product or design commitment.
- **Current wedge** means the next complete experience HII should prove.
- **Substrate** means useful implementation that serves the wedge but is not the
  product by itself.
- **Experiment** means implemented or explored work that still needs current,
  end-to-end proof.
- **Deferred** means intentionally outside the present build sequence.

When this record conflicts with current code or proof, the code and proof win
for claims about what works. When it conflicts with older brainstorming, this
record wins for product direction.

## The shortest complete definition

> **HII is personal intelligence made spatial.**

It is a local-first, user-owned environment where a person works directly with
their information, tools, projects, and artifacts while models help perceive,
connect, transform, and act within explicit authority.

HII is not a stronger chat window. Chat is one gesture among pointing,
selecting, dragging, drawing, typing, speaking, opening, grouping, revising,
and approving. The model is not the product. The product is the person's real
context becoming connected, understandable, actionable, and durable without
first being compressed into a prompt.

The compact architecture is:

```text
Canvas / objects = shared world
Models           = cognition
HII CLI/runtime  = deterministic hands
Receipts         = inspectable consequence and proof
Human            = intent, taste, authority, and final judgment
```

The central research question is:

> How much can HII remove between a person having a thought and the computer
> beginning to move with that thought?

## The product loop

The intended interaction is not repeated prompt and response. It is a shared,
continuous loop:

```text
human does something
→ HII perceives relevant behavior and context
→ HII maintains an evidence-backed intent hypothesis
→ the human or agent manipulates the shared object world
→ consequential work crosses an explicit authority boundary
→ deterministic tools execute
→ HII verifies the result
→ a useful artifact and receipt remain
→ the human reacts, redirects, accepts, or continues
```

The smallest product loop is:

```text
find or bring something
→ place it in context
→ manipulate, speak, type, or gesture
→ visible bounded job
→ new usable artifact or state change
→ proof
```

The first-win version should stay even tighter:

```text
one deliverable
→ useful sources and images
→ source-backed objects
→ one editable artifact
→ non-destructive revision
→ real export
→ receipt linking intent, sources, transformations, verification, and output
```

## The four missing primitives

The discussions repeatedly reduced HII to four primitives around the human,
canvas, and models.

### 1. Living objects

Canvas material cannot be flattened cards or disposable pixels. Every durable
object needs:

```text
identity
type and underlying data
current state
relationships
provenance
available capabilities
version history
permissions
```

A webpage remains a source-backed webpage. A repository remains a repository.
A thought may remain a thought. A sketch retains geometric and semantic
structure. Visual placement is not canonical identity: the same object may
appear in multiple canvases without losing its history.

### 2. Perception

HII should understand work from bounded signals such as:

- cursor location and focus;
- selection and nearby objects;
- movement, grouping, drawing, and editing;
- typed or spoken language;
- open objects and recent actions;
- pauses and the current project objective.

Perception is evidence, not permission. Observation should be scoped,
inspectable, local by default, and independent from authority to act.

### 3. Intent inference

HII should maintain possible interpretations rather than force every action
through an explicit command. An intent hypothesis records:

- what the person may be trying to accomplish;
- which behavior and objects support that interpretation;
- confidence and ambiguity;
- possible next steps;
- whether HII should remain silent, surface a possibility, ask, create, or act.

Inference may be probabilistic. Execution and consequence reporting may not be.

### 4. Hands

HII needs a small stable vocabulary of grounded action primitives:

```text
observe · read · search · create · modify · move · connect
communicate · execute · wait · monitor · verify
```

The runtime composes those primitives across the filesystem, browser, terminal,
apps, APIs, canvas, services, and other machines. The CLI is the agent's
machine-native action language, not the human's required interaction language.

Every machine-facing operation should favor structured output, stable
semantics, declared side effects, discoverability, bounded execution, authority
metadata, and receipts.

## Human interaction grammar

HII can grow to many capabilities but should keep a finite interaction grammar.

The clearest human-facing grammar is:

> **Look · Do · Delegate**

- **Look**: find, browse, compare, inspect, observe, and open.
- **Do**: directly manipulate something or request a bounded operation.
- **Delegate**: assign an objective, then supervise and redirect ongoing work.

Collaboration is the continuing loop between these modes. Approval, governance,
supervision, and verification are controls around interaction, not additional
destinations the user must learn.

Authority is a separate dimension:

```text
observe
→ preview
→ reversible private change
→ external commitment
→ irreversible change
```

Plan, Browse, and See should remain read-only. Build and Show may receive
workspace authority. Sending, publishing, paying, deleting, moving external
state, widening access, or otherwise committing the user requires authority
proportionate to consequence.

The universal rule is:

```text
before consequence: preview or approve
after consequence:  show result and proof
```

## Canvas and entry points

The canvas is a shared cognitive surface, not a dashboard and not a dump of
agent messages. It should contain material worth keeping: sources, questions,
claims, objects, jobs, artifacts, decisions, and receipts.

Transient intent, raw model traces, tool chatter, and low-level logs belong in
backend history unless explicitly revealed. Direct typing on an empty canvas is
the primary low-friction entry. A cursor-local palette remains useful but is
optional rather than a prerequisite.

When present, the palette follows **Bring · Make · Act**:

- **Bring** a file, link, source, image, or other object into the current space.
- **Make** a note, sketch, board, draft, diagram, or new artifact.
- **Act** on the current selection or nearby context.

It appears at the point of attention and reveals relevant possibilities, not a
catalog of integrations. Empty space emphasizes bring and make. A selected
image emphasizes inspect, edit, convert, or find similar. A cluster emphasizes
compare, organize, synthesize, or create from.

The durable visual grammar is:

```text
object · space/context · ask · job · artifact
```

The workspace must resist becoming an infinite junk drawer:

- keep one active deliverable or objective prominent;
- distinguish canonical objects from visual placements;
- group sources, active work, and outputs;
- collapse completed work into checkpoints;
- use semantic zoom, search, and outline views;
- archive inactive material without destroying it;
- keep a visible current bottleneck or NOW state.

## HII as an information-model interface

Browsers represent the web as pages and tabs. HII should represent useful
material as durable, typed, source-backed objects:

```text
sources · claims · people · images · places · questions · projects
relationships · transformations · artifacts · evidence · permissions · receipts
```

The web is material, not merely somewhere to visit. HII discovers or opens a
source, extracts the useful information, preserves URL, author, capture time,
content hashes, quotations, rights context, and change history, then lets that
material participate in a living project model.

The browser engine, tabs, crawling, authentication, rendering, and extraction
machinery may exist underneath. The user-facing object is the information
found, not another browser interface they must manage.

The canonical information flow is:

```text
question or deliverable
→ discover source material
→ normalize it into typed objects
→ connect objects into a project model
→ select and transform the model
→ produce a verified artifact or authorized action
```

SQLite and FTS5 remain appropriate canonical substrate before adding a separate
graph database. HII owns identity, relations, provenance, revisions, authority,
and receipts; retrieval and conversion tools handle bytes behind HII contracts.

Useful low-level substrate includes ordinary HTTP, Playwright for rendered
pages, local SearXNG for discovery, Readability-style extraction, and bounded
media/document tools. Agents should normally reach them through a small typed
HII command surface rather than memorize unrelated CLIs.

## CLI-first, correctly understood

ADR 004 remains accepted: the Rust CLI/runtime owns state, policy, execution,
verification, and the agent contract before a capability is projected into a
visual surface.

This is an implementation and authority decision, not a claim that most people
should live in a terminal. The intended dependency is:

```text
natural human behavior
→ perception and intent inference
→ proposed bounded action
→ CLI-owned capability and authority contract
→ deterministic execution
→ verified result and receipt
→ shared environment update
```

The human experience should make the CLI nearly invisible. HII should avoid two
equal mistakes:

- probabilistic or invisible execution that cannot prove consequences;
- forcing the human to express thought in the runtime's deterministic grammar.

Determinism belongs at the boundary where the world changes.

## Models and provider neutrality

Models are invited, replaceable cognition. They do not own durable state,
permissions, identity, or truth. HII should support local, bring-your-own, and
hosted providers without making the workspace subordinate to one model vendor.

The local model management direction uses four adapters:

| Adapter | Role |
| --- | --- |
| Ollama | dependable default runtime and simple model lifecycle |
| LM Studio / `lms` | richer loading, serving, GGUF, and runtime controls |
| Hugging Face / `hf` | discovery, licenses, acquisition, revisions, and cache |
| HII Native MLX | experimental Apple-Silicon execution for measured wins |

HII should unify discovery, hardware fit, install estimates, provenance,
checksums, licenses, load state, evaluation, defaults, removal, and receipts.
It should distinguish an artifact source from an inference runtime and preserve
valid pipelines such as Hugging Face to MLX or LM Studio.

Model recommendations must be based on the user's machine and measured HII
workloads: tool use, structured output, file editing, latency, verification,
vision, and context—not brand preference or tokens per second alone. HII may
recommend but must not silently replace the user's default. Large downloads,
conversions, hosted transmission, and deletion require visible scope and
appropriate confirmation.

## Provenance, transformation, and memory

Transformations are non-destructive. A derived object records:

- parent object and version;
- user intent and authority;
- model and capability used;
- parameters and changed selection or region;
- output artifact and content hash;
- verification and cost;
- timestamp and receipt.

Users can inspect, compare, branch, roll back, export, or reuse versions. A
source-backed story can bind images and citations, preserve lineage, detect
source changes, branch into a presentation or script, and export without losing
its chain of evidence.

Backend-native history should be append-only across request, interpretation,
action, output, artifact, verification, and receipt. The canvas should reveal
that history only when it helps the current work.

Memory retrieval must remain bounded and provenance-bearing. HII may suppress a
model host's native memory only after it has produced a valid bounded context
pack; failure to retrieve HII memory must not silently erase useful native
context.

## Human authorship and identity

The user owns taste, identity, profile, playlists, canonical order, publishing,
and final judgment.

> **Your taste, arranged by you.**

Agents may propose groupings, labels, revisions, or recommendations. They may
not silently reorder, publish, define identity, or present inferred taste as the
user's authored choice. This principle generalizes beyond music and profiles to
design, writing, architecture, and public work.

## Practice, markets, and business

HII is both a product and the vehicle for a broader multidisciplinary practice:

> **Software for how we think. Spaces for how we live.**

The practice coordinates four related fields:

```text
THINK      research, knowledge, decisions, agents
CREATE     software, design, drawings, models, architecture
OPERATE    companies, projects, capital, and assets
MEDIA      stories, demonstrations, education, and culture
```

These are different markets joined by one operating thesis: create software
and space that help people think, make, coordinate, and live better. HII should
serve as the shared context, action, and proof layer across them rather than
pretend they are one undifferentiated product.

The local personal core should remain compatible with free local and
bring-your-own intelligence. Plausible paid value comes later from optional
sync, collaboration, team governance, managed compute or storage, specialist
integrations, and other shared services. Access to the user's own local context
should not be held hostage to a subscription.

## What to build now

Prove one object-to-artifact loop repeatedly:

1. Start from one question, deliverable, or thing the user wants to make true.
2. Find or accept useful web and local material.
3. Convert it into source-backed objects with visible provenance.
4. Let the user select, arrange, and revise the material directly.
5. Create one editable artifact rather than a prose answer alone.
6. Keep revisions linked and reversible.
7. Export a real file or perform one bounded authorized action.
8. Verify the output and save a durable receipt.
9. Resume later without reconstructing the work.

Measure success with completed artifacts, time to first useful object, prompting
burden, user corrections, provenance coverage, intervention at authority
boundaries, verification quality, and successful resumption—not number of
models, tools, panels, or agents.

## Substrate that should serve the loop

- CLI-owned capability and authority contracts.
- Source-linked object model in the local HII database.
- Search and extraction with local-first, bounded web access.
- Direct canvas manipulation and backend-native history.
- Visible jobs, artifacts, proof, and receipts.
- Non-destructive transforms and export.
- Provider-neutral local model adapters.
- Governed terminal objects and agent supervision.
- Read-only OpenAI/ChatGPT projection when it reflects current HII state.
- Native browser capability only when it produces source objects or supports
  bounded agent interaction.

## Deferred until the first loop is dependable

- a full Chrome replacement and tab-management product;
- a generic integration or skill marketplace;
- broad cloud sync and social network infrastructure;
- credits expansion, decentralized compute, and autonomous commerce;
- complex multi-agent hierarchies as a product feature;
- massive long-term memory without bounded retrieval;
- generalized 3D as a separate product model;
- silent curation, publishing, or identity construction;
- remote-machine claims without working transport and a running executor.

The future shared artifact network remains valuable: users may eventually share
boards, models, research bundles, tools, and decisions with sources, versions,
permissions, and derivation intact. It should grow from artifacts people already
find useful, not be infrastructure built before the local loop works.

## Current evidence boundary on 2026-08-18

Historical project evidence supports these statements, but each is narrower
than a release claim:

- A direct canvas typing and response loop was verified in the newer worktree.
- Governed Plan, Browse, Build, See, and Show modes were implemented with
  distinct authority; Browse proof remained incidental rather than release
  proof.
- A bounded terminal object can be created without executing a command.
- Local SearXNG Browse was exercised through a loopback-only service.
- Profile and Music objects preserve manual order and proposal-only curation;
  playback, remote transfer, and packaged persistence were not fully proven.
- A native development browser and source capture flow were implemented and
  checked at web/build layers; an interactive packaged native-WebKit launch was
  not verified in that task.
- A private read-only HII OpenAI app was implemented locally; it was not
  publicly deployed or connected to ChatGPT in that task.
- Remote systems may be enrolled but remain `pending-agent` until real
  transport and an executor are running.
- Passing static checks is not enough to call a surface or release ready.

Current verification must always re-check the active worktree, process
ownership, ports, runtime state, declared requirements, receipts, and packaged
behavior appropriate to the claim.

## Product tests for every feature

Before adding or keeping a feature, ask:

1. Does it help a person form, navigate, transform, trust, or act on their
   information model?
2. Does it reduce the distance from thought to a useful artifact?
3. Does it fit the finite interaction grammar?
4. Does it preserve human authorship and explicit authority?
5. Does it use CLI-owned state and contracts rather than create parallel truth?
6. Does it leave a useful object, artifact, state change, or receipt?
7. Can it be proved in the actual surface where the claim matters?

If not, it is infrastructure, an experiment, or a distraction—not the next
product feature.

## Final principle

> HII should understand enough of what a person is doing to move with their
> thought, use the smallest reliable vocabulary to act, and preserve their
> context, authorship, authority, and proof throughout.
