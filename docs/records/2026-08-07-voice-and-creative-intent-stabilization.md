# Slice 1 — Stabilize Voice and creative intent

Date: 2026-08-07
Branch: `release/new-user-ready`
Baseline: `961a4b2 feat: establish operational object graph`

## Change

Repaired the workspace follow-up path, moved the Voice runtime onto real
workspace-resolved context, made proposal persistence concurrency-safe, corrected
the speech privacy claim, and withdrew the cursor-bar execution bypass.

## Why

Seven defects were verified against the live tree, not assumed from prior audits:

1. `followUp()` computed the follow-up text and title, then built an intent seed
   without either. Continuing a run produced a blank intent card with no context,
   no parent link and no prepared run.
2. `executeVoiceProposal()` passed `context: []` to both the context preview and
   the queued run, so any context the human selected was discarded at execution.
3. Voice had no concept of the workspace. It probed the frontmost macOS
   application and nothing else.
4. The runtime advertised browser Web Speech as `privacy: 'local-only'`. HII does
   not control what a browser does with captured audio, so that claim could not
   be backed.
5. `writeProposalStatus()` did read-all → `writeFile` with no lock and no atomic
   replacement, and reordered records on every transition. It also destroyed
   history: the file is an approval record, and rewriting it erased every prior
   state a proposal had passed through.
6. `run_cursor_intent` spawned `hii run --cwd $HOME <goal>`. That path did reach
   RunGuard and did write a CLI receipt — the defect was never a missing
   receipt. What it lacked was governance: `$HOME` as the workspace root, no
   reviewed context manifest, no Workspace intent and so no Prepare-agent-run
   transition, no visible approval boundary, no durable object or context scope,
   and a receipt bound to none of the above. Tauri commands are callable from any
   page in the webview, so removing the caller alone would not have closed it.
7. `interpretVoiceInput()` auto-executed whenever `!approvalRequired`. Current
   classifier paths rarely reached it, but the branch was a structural
   voice-only route to execution.

## Files

New:

- `lib/workspace/context-item.ts` — single definition of the context a node
  contributes to a run, shared by the workspace and the voice runtime.
- `lib/server/hii-voice-workspace-context.ts` — resolves a claimed selection
  against the persisted workspace document.
- `lib/server/voice-proposal-ledger.ts` — append-only proposal transition ledger.
- `tests/unit/voice-context-authority.test.ts`
- `tests/unit/voice-proposal-ledger.test.ts`
- `tests/unit/workspace-followup-contract.test.ts`

Changed:

- `lib/server/hii-voice.ts`, `lib/voice/types.ts`, `src/routes/api/voice/+server.ts`
- `src/lib/components/workspace/WorkspacePage.svelte`
- `src/routes/palette/+page.svelte`, `src-tauri/src/lib.rs`
- `tests/unit/agentic-workspace-contract.test.ts`, `aii/capabilities/registry.json`

## Contracts established

- **Voice is an input, never an authorization.** Every proposal with an action is
  written `pending`. There is no path from an utterance to execution that does not
  pass through explicit approval.
- **The reviewed context is the executed context.** Context resolved when the
  human spoke is stored on the proposal and replayed at approval, rather than
  rebuilt or emptied at execution time.
- **Claimed selections are not trusted.** Node identifiers are resolved against
  the persisted workspace; identifiers that do not resolve are reported as
  unresolved rather than fabricated or silently dropped.
- **Speech transport is classified, not asserted.** `SpeechProcessing` is one of
  `local-native | browser-managed | external-provider | unknown`. Web Speech is
  `browser-managed`.
- **The approval record is append-only.** `proposals.jsonl` is a ledger of
  immutable transitions, matching every other HII JSONL store. Prior lines are
  never rewritten, reordered or removed; current state is folded from the
  transitions; malformed lines stay on disk and are reported as structured
  corruption rather than deleted.

## Storage semantics

`$HII_RUNTIME_DIR/voice/proposals.jsonl` is an **append-only ledger**, not a
snapshot collection. This is the same contract `intents.jsonl`,
`conversations.jsonl`, `events.jsonl` and `jobs.jsonl` already use.

Each line is one event:

- `proposal.created` carries the full proposal snapshot and opens its history.
- `proposal.transitioned` carries `previousStatus`, `status`, `at` and a field
  patch.

Every event has a stable `eventId` (`<proposalId>:<transitionKey>`), so a retried
transition appends nothing twice while distinct transitions racing under the
shared file lock each get their own line. Current state is the fold of the events
in file order.

Malformed lines are never removed. `readVoiceProposalLedger` reports them as
`{ line, reason, raw, proposalId }` with the raw bytes preserved, and
`snapshotVoiceRuntimeState()` surfaces the count and the first twenty so a
damaged approval history is visible rather than a quietly shorter list.

## Migration

No persisted schema changed shape and no file is rewritten. `VoiceProposal` gains
optional `context` and `workspaceRoot`. Pre-ledger `proposals.jsonl` files hold
bare proposal snapshots with no event envelope; those are read as synthesized
`proposal.created` events, so old files load unchanged and gain ledger semantics
from their next transition onward without being rewritten.

## Verification

- Full unit suite: 69 files, 368 tests, all passing.
- `npm run check`: 1345 files, 0 errors, 0 warnings.
- `npm run build`: succeeds.
- `cargo check` in `src-tauri`: clean, no warnings.
- `git diff --check`: clean.
- Live-server proof against an isolated `HII_RUNTIME_DIR` seeded with a workspace
  containing a real node: `/api/voice` resolved `kitchen-plan` into a context item
  carrying its source and excerpt, reported `ghost-node` as unresolved, resolved
  the scene title, wrote the proposal as `pending`, and reported speech as
  `browser-managed`. Approval stopped at the local-model gate and left the
  proposal `pending` rather than advancing it.

## Remaining risk

- Queued execution was not proven end-to-end at runtime: no local model provider
  was running. The unit suite proves the context reaches
  `queueApprovedWorkspaceRun` with a mocked provider.
- Microphone capture in the packaged Tauri application is untested. The voice
  capability is recorded `partial` for this reason.
- The Notch does not yet publish the live workspace selection, so spoken context
  is only as rich as what a caller supplies. The server reports honestly when
  nothing was selected rather than inventing a selection. Voice is therefore
  recorded `partial` and is **not** described as fully selection-aware.

## Deferred: cross-window live selection handoff

Belongs to the later durable ContextRef slice, not here.

Selection must not be added to the persisted `WorkspaceDoc` merely to move it
between windows — that would put transient UI state into the authoritative
document. That slice should first look at the Tauri events and window-state
infrastructure already in the repo, or a small ephemeral coordination channel
carrying only `workspaceId`, `workspaceRevision`, `selectedNodeIds`,
`activeSceneId`, `sourceWindow` and `capturedAt`.

Whatever carries it, the server keeps resolving those ids against the
authoritative workspace document. A published selection is a claim, not context.

## Next dependency

Slice 2 — completion and artifact truth. Semantic completion must land before any
generative artifact depends on `completed` status.
