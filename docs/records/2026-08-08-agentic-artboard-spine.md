# The agentic artboard spine — slices 3 through 10

Date: 2026-08-08
Branch: `release/new-user-ready`
Baseline: `d2a4d30 fix: enforce completion and artifact truth`

## What now holds end to end

```
INTENT → REVIEWED CONTEXT → APPROVAL → BOUNDED EXECUTION
       → DECLARED OUTCOME → VERIFIED RESULT → RECEIPT → OBJECT → LINEAGE
```

Each slice has its own tests. `tests/unit/agentic-artboard-integration.test.ts`
exists for the failures that only appear between them: an approval surviving a
context change, a grant widening when a rectangle moves, a variant appearing
after a run that produced nothing, lineage not surviving a restart.

## Guardrails (`e226506`)

Only `proofStrength: declared` with a satisfied assessment unlocks high-trust
behaviour — capability drafting, skill promotion, verified workflows,
VERIFIED_BY, trusted generated provenance, external-effect readiness, and any
label that says "verified". One helper per side (`lib/server/proof-policy.ts`,
`ProofStrength::qualifies_for_high_trust`) rather than scattered string
comparisons, because every place that drifts is a place where a run nobody asked
to verify quietly becomes a verified thing.

Declared verification pipelines fail closed. The previous wrapper fell back to
last-command exit status when a shell lacked `pipefail`, silently reintroducing
the masking it existed to prevent. Where pipeline status cannot be established,
the check is refused rather than run: a check reporting `ok` without seeing a
failed stage is worse evidence than none.

## Slice 3 — versioned graph mutations (`e0160f1`)

Three version domains, kept separate: semantic, projection, relation. A move
must not invalidate the semantic context an approved run was reviewed against,
and a semantic edit must not look like a drag. Optimistic concurrency, content-
hashed idempotency keys, canonical ownership (`workspace-json` records refuse
graph-first writes), structured refusal codes, tombstones that never remove
rows. Authored workspace links project as `AUTHORED_LINK` with the label kept as
data — previously the label became the relation type, so typing `VERIFIED_BY` on
an arrow forged proof.

Atomicity is claimed only inside SQLite. Workspace JSON and the database are two
files with no shared transaction; the JSON stays canonical and the graph follows
idempotently.

## Slice 4 — durable context references (`9d7dd5d`)

`ContextRef` points and carries no content. `ResolvedContextItem` is the current
reading. `ReviewedContextManifest` is the one place content is copied on purpose,
hash-locked so an approval cannot be carried onto context that changed. Missing,
stale and blocked references are reported, never dropped.

Cross-window selection is an in-memory 90-second channel carrying coordinates
only. Selection is transient UI state; persisting it in `WorkspaceDoc` would make
every click a revision and let a stale save resurrect a selection nobody made.

## Slice 5 — governed object tools (`bbf58a0`)

One interface, reached identically from HTTP, CLI and agent tools. Object scope
is enforced independently of filesystem scope. Annotation is separated from
semantic editing, frame placement from write access, and tombstoning is denied by
default even for writable objects. Object *writes* are deliberately not a
free-form agent tool: a mutation needs a scope, a base version and an idempotency
key, and guessing those is what the interface exists to stop.

## Slice 6 — generative branching (`f81e6f0`)

Select, instruct, review, approve, run, and get a sibling — never an edit. The
variant is materialised from the run's completion assessment, not from a file
appearing, so a failed run leaves the canvas exactly as it was. Lineage is typed;
`VERIFIED_BY` appears only with declared proof, so an unverified branch is
visibly unverified.

## Slice 7 — object grants and territories (`5d95762`)

A grant is a record a human approved, not a scope a caller described. It must
end. A territory is a *rendering* of a grant: moving the rectangle changes where
it is drawn and nothing about what it permits, because inferring authority from
geometry would let an agent widen its own permissions by dragging a box.

## Slice 8 — model discovery and routing (`379f66a`)

One provider-neutral catalog. Unknowns stay `null` — context windows, latency,
quality and cost are not invented, and image support reports `null` rather than
`false` for an unrecognised name. MLX and llama.cpp are named as unsupported.
Routing uses requirements, modality, privacy and availability only; a manual
override always wins, and a named-but-absent override is reported rather than
silently substituted.

## Slice 9 — context packs (`b04043e`)

Pointers and recorded versions, never a second copy of Dock or workspace content.
Drift is detected by content hash rather than document revision, because a
workspace revision is document-wide and would mark every reference stale on any
unrelated save — noise that trains a person to click through the warning.

## Slice 10 — the Notch (`035eb89`)

One state, one message, one primary action, from a precedence ordering that *is*
the policy. Native window mechanics untouched. Packaged Tauri proof not run, so
voice capability status stays `partial`.

## Runtime proof

Isolated `HII_RUNTIME_DIR` throughout; the real `~/.hii` was verified unchanged
at 299 receipts afterwards. Ollama was started for the run proof and stopped
again.

**Governed path, real approved grant:**

| | Result |
| --- | --- |
| objects visible under grant | only the granted one |
| read outside scope | refused |
| operation not in the grant | refused |
| granted operation | applied, v1 → v2 |
| stale write | refused, `stale-version` |
| forged VERIFIED_BY | refused, `authority-mismatch` |
| territory stretched to 99999×99999 | scope unchanged, read still refused |
| operation record | carries grant, intent, run, base → result |
| CLI with inline `--scope` | refused: "a caller describing its own authority" |

**Declared outcome, real `hii run` against qwen3:14b:**

| | Result |
| --- | --- |
| artifact present | `completed`, exit 0, proof `declared`, in inventory |
| receipt sha256 | `131d3f34…` — matches the file on disk exactly |
| artifact removed | `incomplete`, `verify-failed`, exit 3, `missingArtifacts: ["variant.md"]` |

## Verification

`npx vitest run` 508 tests · `cargo test --workspace` 216 · `cargo clippy
--workspace --all-targets -D warnings` clean · `cargo fmt --check` clean ·
`hii check` clean · `npm run check` 1358 files, 0/0 · `npm run build` succeeded ·
`git diff --check` clean.

## Known limits

- Packaged Tauri smoke (open/close, shortcut, mic, approval, completion,
  return-to-object) not executed. Voice stays `partial`.
- The Notch's expanded panel still shows dashboard-level history; the state model
  no longer depends on it.
- Image variants are supported by contract but only proven for text on this pass.
- Latency, quality and cost fields in the model catalog are structurally present
  and empty; routing ignores them by design until something populates them.
