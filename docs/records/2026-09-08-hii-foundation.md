# HII foundation: an interface for living in a digital world

Status: implementation in progress. This is the running architecture and decision record for this work, not a claim of release readiness.

## Product thesis

Ummi's direction on September 8 is for HII to become the only software a human and their agent need to live life in a digital world. That is broader than a development tool or task dashboard. HII should be the coherent environment through which a person understands information, creates, acts, and returns to ongoing work. External applications and services remain capabilities and surfaces within that environment.

The founder's clearest metaphor is **the next generation of pencil and paper**: a platform for human creativity and digital well-being. User data stays on the user's system by default. Sync to another system is a deliberate choice. The fabric and social platform extend this medium so people can intentionally post, collaborate around, sell and monetize their data and creations. These belong to the product vision; their implementation must preserve the distinction between private work and chosen sharing. Infrastructure quality serves creative agency and well-being, rather than becoming the purpose of the product.

The conceptual center is **durable objects acted on through bounded runs**. A person addresses something, expresses intent, sees the proposed consequence, permits the relevant action, and receives inspectable changed state and evidence. Ummi clarified that **canvas and CLI are the main interaction surfaces**: humans and agents place assets, manipulate them, and view varied information and collected data through both. Text, voice, browser, and 3D extend engagement with that shared world. Models are replaceable participants. HII must own identity, context boundaries, authority, state transitions, and evidence.

The first architectural priority is reliable shared state under simultaneous human and agent work. A richer interface cannot compensate for addressing the wrong workspace, losing a competing edit, or treating a dead executor as active.

HII should remove the need to switch applications and reconstruct context for each tool. The work a person does, and wants to do, shapes their own version of HII: assets, projects, relationships, preferred tools, and repeated workflows compose a personal environment over time. Adaptation should bring useful capabilities into the existing working context while preserving predictable object identity and user control. A consistent substrate supports personal configurations; it should not force every person into the same interface arrangement or fork the underlying product per person.

The founder's delivery role is to ship the essential starting experience, prove utility, and create content that brings people into the platform. Paid enterprise setup and future compute, storage and hardware are intended business paths. The engineering recommendation is to earn those extensions through demonstrated workflows: infrastructure purchases should add useful capacity and service while the user's local information remains usable and portable independently. Pricing, enterprise readiness and demand are not established by this source work.

## Architecture as implemented

| Boundary | Current implementation | Judgment |
| --- | --- | --- |
| Human surface | Next target selects desktop/account access; `components/workspace/HiiRoot.tsx` renders the object workspace, with local chat also available in desktop access | Preserve the shared workspace; chat is one input/surface, not the durable world |
| Optimistic interaction | `components/workspace/useWorkspace.ts` handles local state, undo, acknowledged save and rebase through persistence adapters | Context flushes pending writes; undo preserves unrelated work; independent fields merge |
| Native persistence | `lib/client/hii-bridge.ts` → Tauri commands → `hii-core` runtime Space APIs → SQLite objects/projections/events | This is the actual native canvas authority; strengthen it before another model |
| Compatibility persistence | Named workspace JSON imports/exports; TypeScript workspace store still serves local scripts; browser/account adapters have different storage paths | Do not call all stores interchangeable or delete live consumers; keep ownership explicit |
| Execution | Rust CLI tools, scoped context, governance, run journal, completion assessment and receipts | Strong primitives already exist; enforce their guarantees consistently |
| Context | Source-linked Context Dock, compiled packs and approved fingerprints; workspace selection supplies object context | Context must come from an acknowledged workspace revision before execution |
| Memory | `hii-core` information/operational/runtime modules and TypeScript context/knowledge stores share local SQLite foundations | Preserve durable provenance; consolidate authority before renaming vocabulary |
| Providers | CLI provider adapters and `hii-chat` for native local chat; local runtimes are replaceable | Provider output is not execution or verification evidence |
| Observation | Node CLI home projection reads registered instances, daemon reports and process probes | Cached registration must be distinguished from current execution evidence |
| Devices/network | Fabric crates, native runner, adapters, account/Space services and public worker | These are real subsystems with separate proof gates; registration alone cannot establish live remote authority |
| Legacy runtime | `aii/` daemon, capabilities, skills and model-runtime code remains consumed by active scripts | Migration debt, not automatically dead code; no bulk deletion based on names |

## Findings and decisions

### 1. Space identity must survive every boundary

The shared Rust wrapper accepted an explicit Space ID but imported the globally selected workspace JSON. Its mutation path then exported back to the selected workspace path. Thus a background agent addressing one Space could import another's private objects or overwrite its compatibility document. History and sharing could trigger the same faulty import.

Resolve runtime root and Space identity once per operation. Carry those coordinates through import, revision comparison, mutation, history and export. The old single `workspace.json` belongs only to `default`; a new named Space starts empty. Unreadable/corrupt named state is an error, never permission to substitute another canvas. Reuse the runtime ID validator rather than adding another validation vocabulary.

Hold the existing cross-language file lock through native mutation and compatibility export. SQLite remains authoritative after initialization; an idempotent retry can repair an outdated export. JSON export and SQLite commit are still two persistence operations: a filesystem failure after commit must not be mistaken for a rollback.

### 2. Revision checks belong inside the transaction

Runtime apply previously read and checked a sequence before reserving the database writer. Two agents could both pass the check, then overwrite each other. Initialization, sharing and revocation had related read-before-write windows. Snapshot assembly could mix rows from different commits, and a mutation could return a later writer's snapshot.

Use SQLite immediate transactions for writers, authorize and check sequence inside them, and construct the response within that transaction. Read snapshots through a read transaction. This uses the existing database and sequence model; no new coordinator or event bus is needed.

Idempotency also needed an identity boundary: a derived event's key could suppress a later transaction, and reusing a transaction key with a different payload silently succeeded. Only transaction events now deduplicate requests; new events retain a request fingerprint and reject reuse for different content or actors. Older events without a fingerprint preserve compatible retry behavior. An explicit request Space must match the runtime target.

### 3. Observed state must say what was actually verified

The initial `hii home --json` reported 33 active instances whose process probes all returned `live: false`, from a six-day-old daemon snapshot. That misleads both the human and the next agent about available execution.

Separate current local process evidence, stale reports and unknown/remote identity. Do not probe a remote PID locally. Ledger jobs remain reported work, not process-liveness evidence. Preserve inspection coordinates so missing observation is actionable.

### 4. Completion is durable evidence, not a final message

The CLI completion assessor selected the first verification attempt, while execution accepted a later passing retry. Receipts were overwritten non-atomically, finalization disabled recovery before persistence succeeded, and time-plus-PID store IDs could collide within one process.

Keep the latest verification result per command for the current mutation epoch; the existing journal retains attempt history. Read historical vectors from newest to oldest. Reuse the private atomic file writer for receipts and pointers, mark finalization only after persistence, and preserve terminal evidence with an unsatisfied infrastructure-error assessment when persistence fails. Add UUID suffixes to run and conversation IDs while retaining sortable timestamp prefixes. No new receipt layer or dependency is needed.

## Work ownership

The starting checkout was `main` at `d70947ac`, with 46 pre-existing changes, including staged component deletions and active Drive, CLI, and workspace work. Ummi subsequently authorized integrating Claude's work and pushing all source to main. Existing work is preserved and reviewed as part of this integration. Generated Python environments and desktop verification output remain on disk but are ignored; private workspace data is not included.

## Remaining debt and next leverage

1. **Committed context before execution — repaired.** Context compilation and approval await the hook's persistence acknowledgement. Execution derives its request from the approved pack, not the original selection. Explicit exclusions survive ambient retrieval and history ranking and affect the fingerprint.
2. **Undo that respects concurrent work — repaired.** Reverse fields still owned by the local edit, preserving newer independent changes, additions and links. The hook no longer restores whole node-array snapshots. Removed the unused `lib/workspace/history.ts` implementation; its feature tests now exercise the same reverse-change primitive used by the live hook, including legacy documents without links.
3. **Actual authority at Space mutation — repaired.** Runtime validates stored grant subject, Space, action, expiry, revocation, actor kind and optional run binding inside the transaction and before idempotent replay. Only the local owner bypasses grants. Trusted CLI/MCP adapters issue scoped persisted grants after their existing authority gate and cannot reactivate revoked grants.
4. **Field-level conflict semantics — improved.** Three-way merge preserves independent geometry/content/metadata changes. Same-field conflicts retain timestamp precedence and arrays remain atomic; this is not a CRDT or collaborative text editor.
5. **Persistence ownership convergence.** Native SQLite, compatibility JSON, browser storage and account storage need explicit adapter contracts, replay and conflict tests. A single filename or a new generic repository layer will not establish a single authority.
6. **Real life acceptance.** Prove a non-HII task from selected source through bounded action to a useful artifact, reopen it after restart, and inspect its evidence. Source tests do not prove installed-app experience, remote transport, or daily usefulness.

## Verification log

- Public Rust workspace identity regression passes in a subprocess with an isolated temporary runtime: explicit Space import/apply, selected Space preservation, default-only migration, empty new Space, corrupt/unreadable state, history/share migration and idempotent export repair.
- Runtime concurrency tests pass for competing initialization, competing proposals, and sharing/revocation; existing runtime tests also pass.
- Observation fixtures and existing home smoke pass. Live home now distinguishes the stale daemon reports from active executors.
- Full validation, final commit and local skill receipt will be recorded below when completed.

## Founder clarification and shipping boundary

HII is **one product**, not distinct web and desktop products. The same connected workspace must mirror objects and edits in both. Native installation adds local models, PTYs and OS capabilities unavailable in browsers. Canvas and the friendly cross-platform terminal are the initial product wedge, not another chat application. Free usefulness should earn habitual use; optional compute/storage and network services must not make HII responsible for every user's infrastructure bill.

User-owned infrastructure is the default direction. Identity, storage ownership, compute and publication are separate permissions. Existing account synchronization stores document data on HII infrastructure; it is an explicit hosted option, not proof of user-hosted mirroring. Local file paths and browser IndexedDB blobs are not transferable assets merely because their object metadata synchronizes. No private documents were uploaded to resolve this discrepancy.

September 8 read-only investigation found the account board `ummi HII` at revision 58 with two objects, versus selected local `launch-proof` with 33 at revision 815 and `default` with 181. No account object IDs matched the local documents. This proves disconnected documents, not loss of the user's specific missing content. Native workspace navigation now exposes existing local boards with counts, preserves unreadable files, and opens a selected board without uploading it. Account workspaces are labeled as mirrored with web; object metadata mirroring is regression-tested through both actual persistence adapters against one simulated authoritative service, including conflicting edits and reopening.

Claude's completed canvas work is retained: rendered governed runs, explicit approval, handle chips, typed outputs, artifact placement with lineage and 3D projection state. Canonical assigned handles now survive SQLite persistence. Signing into the browser preserves browser-only work until an explicit workspace switch.

Public release blockers found: missing installer route, incompatible CLI filenames/checksum contracts, absent R2 publication in CLI CI, and missing updater feed. The installed Mac app was a noon build, predating these fixes. The old package smoke targeted an obsolete Node-server layout. These are release-engineering failures, not evidence that all product primitives are broken.

Remaining acceptance beyond source tests: current installed native visual/run proof; Windows and Linux native validation; authenticated asset transport for user-owned web mirroring; explicit existing-board connection/reconciliation; signed/notarized public artifacts and verified updater delivery. Never silently merge or upload existing personal boards as a release step.

## September 9 integration

- Account workspaces now bind their authenticated identity to an exact local Runtime Space. Hosted revisions and Runtime sequences remain separate. Polling and writes reconcile local CLI/agent edits using three-way merge and bounded compare-and-swap retries. Same-field account conflicts fail explicitly rather than using timestamp precedence; pending local work survives failed uploads and concurrent edits. Unbound nonempty local Spaces cannot be silently overwritten.
- Account context packs are restricted to selected objects in that bound Space. Ambient local instructions, knowledge, jobs and receipts are excluded at compilation and approval revalidation, preventing account work from accidentally gaining unrelated machine context.
- First-time account linking preserves an existing populated local canvas rather than silently replacing it with the account's default board. Explicit account preferences still win. Offline account reads currently report an error rather than presenting a cached offline canvas; this remains a resilience gap.
- Named states ship through `hii state save/list/show/restore`, using snapshot events in the existing operations history, not another store. Restore previews by default, requires an expected sequence to apply, saves a safety checkpoint, and never restarts saved terminal commands. See `../named-states.md`.
- The existing HII Drive prototype is preserved but accurately labeled: no working watcher or network synchronization. Path confinement, chunk hashes and atomic reconstruction are tested; it is not the shipped cross-device asset transport.
- Installer routing, archive/checksum names and CLI publication automation now agree. Updater manifests use version-pinned artifacts and truthful architecture coverage. Public release remains gated on real signing/notarization and published artifacts, not merely these source repairs.

Final source verification: 837 frontend tests in 136 files; core 54 unit and 2 integration tests; account projection 10 native tests and 11 adapter tests; CLI 515 tests plus named-state parsing; Drive 10 tests. TypeScript passed. Native clippy passed with the pre-existing Tauri command argument-count lint allowed; this is not an unqualified strict-lint pass. Package, deployment and installed-app evidence follow after those operations complete.
