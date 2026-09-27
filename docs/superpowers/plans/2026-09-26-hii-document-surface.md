# HII Document Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Foreground owns integration, final validation, and external actions; route bounded code to an available verified local or lower-cost worker.

**Goal:** Make one minimal document surface available through an always-on HII CLI-backed web UI and the existing HII workspace.

**Architecture:** HII's runtime owner persists document Yjs updates and revisions in its SQLite database. A managed headless BlockSuite worker handles schema-aware operations; the browser and Tauri render the same document objects. CLI and HTTP handlers call the same service contract.

**Tech Stack:** Rust/Axum/Tokio/SQLite; TypeScript/React/Lit; BlockSuite source pinned at `5cb5cb68471ca692f3c162258f0087cb22fcb82d`; Yjs 13.6.21; Node 22 for this BlockSuite checkout.

**Spec:** `docs/superpowers/specs/2026-09-26-document-network-design.md`

## Global constraints

- Port 4188, loopback listener, one runtime owner; local network gateway is separate scoped transport.
- No independent browser truth store, editor database, provider registry, or model daemon.
- Stable document/block IDs; agent proposals include baseRevision, permitted block IDs, and expected text.
- Context pack default 4,096 tokens; attachment packets stay capped at 6,000 characters.
- No persistent sidebar. Dark single-column document with compact contextual composer.
- A Saved acknowledgment follows durable commit; no hosted model escalation.
- Preserve current user documents, Space objects, chat history, dirty worktrees, and installed release rollback.

## Review focus

1. BlockSuite test-only helpers mistaken for production APIs: Task 1 proves a production Workspace.
2. Desktop and CLI contend for the chat owner lock: Task 2 verifies one owner and concurrent clients.
3. Agent edits arrive after human changes: Task 3 rejects stale semantic edits without data loss.
4. Service restarts after optimistic browser edits: Task 4 restores acknowledged edits and retains/retries pending ones.
5. Large imports silently fill model context: Task 5 proves selection/retrieval budgets and explicit truncation.

### Task 1: Prove the production editor/worker contract

**Files:** create `lib/documents/blocksuite-workspace.ts`, `lib/documents/blocksuite-worker.ts`, `lib/documents/contract.ts`, `tests/unit/blocksuite-document-contract.test.ts`; modify `package.json` and lockfile only for selected pinned dependencies. Reference the cloned fork's Workspace interface, BlockStdScope, ViewExtensionManager, and starter empty document; do not ship TestWorkspace.

**Interfaces:** `HiiDocumentSnapshot {docId, revision, stateVector, update, blocks}`; `HiiDocumentPatch {docId, baseRevision, allowedBlockIds, operations}`. Worker exposes JSON-RPC `loadDocument`, `stagePatch`, `commitStage`, `discardStage`, `exportMarkdown`. Binary fields use bounded base64 only over local IPC, never agent prompt text.

- [ ] Add a failing contract test for production Workspace creation, minimal affine page/surface/note/paragraph, and a stable paragraph ID.
- [ ] Implement `HiiBlockSuiteWorkspace` against the current exported Workspace interface; mount with `BlockStdScope({store, extensions}).render()`.
- [ ] Add a headless test applying one paragraph edit, exporting Markdown, reloading Yjs state, and preserving IDs.
- [ ] Run the focused test and one browser-only mount proof. If required services or Node/headless loading fail, record the precise failed boundary and revise the adapter before adding product features.
- [ ] Commit the pinned adapter and evidence; do not substitute an old documentation snippet or a playground test store.

### Task 2: Establish CLI/runtime document ownership

**Files:** create `crates/hii-core/src/documents.rs`, `cli/src/document.rs`, `cli/src/local_runtime.rs`; modify `crates/hii-core/src/lib.rs`, `cli/src/main.rs`, `cli/src/local_chat.rs`, `src-tauri/src/chat.rs`, and `lib/desktop/chat.ts` for the necessary owner/client boundary; test `crates/hii-core/tests/documents.rs` and `crates/hii-chat/tests/database_ownership.rs`.

**Interfaces:** `DocumentService.create(title, space_id)`, `read(doc_id, block_ids, budget)`, `stage(patch, actor_scope)`, `commit(stage_id, expected_revision)`, `events(after_sequence)`. CLI wrappers return the same JSON contracts. SQLite adds versioned document snapshot/update/proposal tables and Space object references within existing migration conventions.

- [ ] Write durability, transaction rollback, duplicate command ID, and competing owner/client tests; run to establish the failing behavior.
- [ ] Implement owner discovery and local IPC so desktop and CLI use one durable chat/document service rather than independently acquiring the same chat owner lock.
- [ ] Implement document transactions and worker staging: validate scope/revision, commit update and receipt atomically, then broadcast the durable event.
- [ ] Add `hii doc new/read/propose/apply/export` commands with the spec's options.
- [ ] Run focused document/ownership tests, then `cargo build` and `cargo test` from `cli/`; inspect CLI-created state after process restart and confirm another Space object was untouched.
- [ ] Commit this independently usable CLI slice.

### Task 3: Scoped agent proposals, conflict handling, and undo

**Files:** create `lib/documents/proposals.ts`, `lib/documents/context-pack.ts`; modify `crates/hii-core/src/documents.rs`, `cli/src/document.rs`, and existing core context-pack integration; test `tests/unit/document-proposals.test.ts` and the Rust document suite.

**Interfaces:** operations are insert_block, replace_text, format_text, remove_block; each patch uses Task 1's schema. A conflict response contains currentRevision and a bounded fresh excerpt. `undo(receipt_id, actor_scope)` creates an inverse scoped transaction.

- [ ] Test an agent proposal based on revision 12 against human revision 13: application returns conflict and preserves both the document and proposal.
- [ ] Implement selected-block context packs at 4,096 tokens, using source IDs and inclusion/exclusion records.
- [ ] Implement apply/dismiss/undo; test Undo preserves an intervening change by another actor and rejects operations outside allowedBlockIds.
- [ ] Prove a CLI-only agent task reads a selection, proposes a change, and commits it through the same owner; no browser automation is required for agent authority.
- [ ] Commit proposal semantics and receipt evidence.

### Task 4: Ship the minimal always-on document page

**Files:** create `components/workspace/documents/HiiDocument.tsx`, `components/workspace/documents/HiiDocumentEditor.tsx`, `lib/documents/client.ts`, `surfaces/local/index.html`, `surfaces/local/main.tsx`, `surfaces/local/vite.config.ts`; modify `components/workspace/HiiRoot.tsx`, `cli/src/local_runtime.rs`, `cli/src/main.rs`, and release resource packaging. Test `tests/browser/hii-document.spec.ts` plus Rust runtime-lifecycle tests.

**Interfaces:** `hii ui start [--open]`, `status --json`, `stop`. HTTP methods wrap Task 2, with local session authentication, Host/Origin checks, and resumable SSE/WebSocket revision events. CLI/Tauri use the same owner methods. Static bundle mounts the shared HiiDocument component; document IDs map to existing workspace nodes.

- [ ] Test two start calls yield one owner, closing the launching terminal leaves the service running, and a service restart recovers the same doc revision.
- [ ] Implement the dark single-column page, searchable title picker, New/Share, text selection actions, contextual composer, inline proposal controls, keyboard/touch behavior, and visible save state.
- [ ] Test browser editing followed by CLI read, CLI proposal followed by live browser receipt, offline pending edits, reload, reconnect, code copy, and mobile viewport.
- [ ] Add a user-triggered importer for current local chat history so the port 4188 migration does not discard conversations or file references.
- [ ] Build/version static assets with the CLI; run focused browser proofs, `npm run check`, application build, and packaged launch/restart verification. If site serving changes, deploy and verify that serving path under AGENTS.md.
- [ ] Install a reversible release, replace the old port 4188 service only after migration proof, and commit the slice.

### Task 5: Attachments become document objects

**Files:** modify `runtime/model-runtime/intake.mjs`, `lib/documents/blocksuite-workspace.ts`, `lib/documents/context-pack.ts`; create `components/workspace/documents/HiiAttachment.tsx`; test `tests/unit/document-attachment-context.test.ts` and the existing intake suite.

- [ ] Test a large PDF or code source appears as an HII file reference, not an embedded base64/text dump, and model packets stay within both documented budgets.
- [ ] Connect upload, normalized preview, extraction warnings, and bounded retrieval to document attachment blocks; preserve original filenames and source hashes.
- [ ] Reuse HII's selected native runtime and verified loaded-model health; test no catalog-only model is silently loaded.
- [ ] Prove one image question and one document-source question through the packaged web page; record prompt size and returned source reference.
- [ ] Commit and record a `hii skill report` with verified/unverified boundaries.

## Completion gate

One CLI-created document survives service restart, is editable in web/Tauri, is readable by a CLI agent with a bounded context pack, and accepts a visible conflict-safe proposed edit with a durable receipt. The document page stays available after the initiating terminal closes. Only then start the peer communication plan.
