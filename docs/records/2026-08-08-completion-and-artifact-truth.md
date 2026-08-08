# Slice 2 — Completion and artifact truth

Date: 2026-08-08
Branch: `release/new-user-ready`
Baseline: `e74a969 feat: stabilize voice and creative intent flow`

## Change

A run may be represented as completed only when its declared outcome
requirements are actually satisfied. Completion is now decided once, persisted in
the receipt, and read by every other surface.

## The false positive, reproduced before it was fixed

Receipt `19fcb7de23b-721e` in the live runtime:

- goal: `notify HII svelte-check errors after Codex session`
- `status: completed`, `outcome: completed`, `exit_code: 0`
- `artifacts: []` — nothing was notified and nothing was produced
- one verification record, `ok: true`, whose own output reads:
  `svelte-check found 0 errors and 0 warnings` followed by
  `Error while loading config at /Users/ummi/hii/aii/workstation/vite.config.ts`

Running that command directly confirms it exits **0**. So the exit status was
captured correctly — this was never a swallowed status, a wrong process, or a
wrapper discarding a code.

The actual cause was the completion rule:

```rust
let completed = final_summary.is_some()
    && verification.iter().any(|check| check.ok)
    && declared_checks_passed;
```

`options.verify` was empty, so `acceptance_passed` returned true vacuously, and
the entire proof standard reduced to *any* tool call the model chose that
happened to exit zero. Status was inferred from the existence of a passing
command rather than from the goal's outcome, and the check that carried the run
was never declared by the contract.

## Repairs, at the source

1. **Declared outcome requirements** (`cli/src/contract.rs`). Optional and
   versioned on the work contract: an outcome kind plus zero or more required
   artifacts, declared through `--outcome` and `--require-artifact` before the
   run starts. Never inferred afterwards from files that happened to appear.
2. **One canonical completion assessment** (`cli/src/completion.rs`). Evaluates
   the final response, the declared checks, required artifacts and their
   validation, cancellation and termination. Persisted in the receipt as
   `completion` (schema v6).
3. **A declared check is satisfied only by a record for that exact command whose
   process succeeded.** A different command exiting zero is evidence about that
   other command. A declared check that never ran is a failure with a warning
   naming it.
4. **Proof strength is recorded, not assumed.** `declared` when the contract
   named checks or artifacts; `incidental` when nothing was declared and the only
   evidence is a model-chosen command that exited zero; `none` otherwise. The
   `incidental` case stays completable — that is what every pre-requirements run
   was held to — but it carries a warning saying it is not proof the goal was
   met, so no consumer can silently upgrade it.
5. **Pipeline status masking** (`cli/src/tools.rs`). `a | b` exits with `b`'s
   status, so `npm test | tee log` reported success while the tests failed.
   Verification commands containing a pipe now run under `pipefail`, guarded so a
   shell without the option leaves the command unchanged rather than failing on
   the option itself.

No stderr regex and no hardcoded error message was used anywhere.

## One definition, three surfaces

The daemon previously applied its own rule — receipt status plus any passing
check — which meant a run could be failed by the CLI and completed by the daemon.
It now calls `receiptCompletion()` and reports the assessment's reasons instead
of a bare "failed". The verdict is carried onto the CapabilityJob metadata so
downstream surfaces read it rather than re-deriving it, and
`lib/server/workspace-run-completion.ts` gives the web side the same reader.
Capability drafting now requires the same verdict the run was held to.

## Backward compatibility

- Contracts without outcome requirements keep informational-task behavior.
- Receipts without a `completion` field still load; their verdict is computed
  from the old rule and reported as `legacy` proof, never as stronger evidence
  than they contain.
- `status` stays the same three coarse values and exit codes are unchanged, so
  every existing `&&`-chained consumer keeps working. A declared outcome that was
  not produced classifies as `verify-failed` (exit 3), which already meant "the
  run did not prove what it claimed".
- `workspace-object` outcomes are **refused**, not silently satisfied. Governed
  object tools do not exist yet, so HII cannot verify one.

## Verification

Commands run and their results are recorded in the Slice 2 section of the pass
report. Runtime proof used an isolated `HII_RUNTIME_DIR` and a temporary git
workspace in the session scratchpad; the real `~/.hii` was not modified.

| Scenario | Result |
| --- | --- |
| informational, no artifact required | `completed`, exit 0, proof `declared` |
| artifact declared, none produced | `incomplete`, `verify-failed`, exit 3, `missingArtifacts: ["report.md"]` |
| artifact declared and validated | `completed`, exit 0, hash in receipt matches the file on disk, path in the artifact inventory |
| declared check fails | `incomplete`, `verify-failed`, exit 3, `failedChecks` names the exact command |

In the last case the model also ran an undeclared `npm test` that failed. It
neither rescued the run nor became the stated reason — the declared check is what
the verdict rests on.

## Remaining risk

- `workspace-object` outcomes are declared-but-refused. They become real in the
  slice that adds governed object tools.
- The `incidental` proof tier keeps legacy runs completable by design. Tightening
  it into a hard failure is a product decision, not a correctness one, and would
  break every existing caller that declares nothing.
- Artifact content and schema validation beyond existence, kind, emptiness,
  extension and hash is not implemented.

## Next dependency

Slice 3 — the Operational Graph mutation contract. Both halves of the trust loop
are now closed: intent → reviewed context → approval → bounded execution →
declared outcome → verified result → receipt.
