# Codex-first HII harness hierarchy

Status: current founder operating decision

Date: 2026-09-20

## Current hierarchy

```text
Ummi and Jabreel
  -> Codex lead harness
  -> HII local control plane
  -> local model or transitional Hermes adapter
  -> authenticated device executor
  -> verification, receipt, and durable HII memory
```

Codex remains the lead intelligence and coordination harness now. HII owns
approved context, authority, capability routing, device identity, execution
boundaries, verification, receipts, and durable user-owned memory. Hermes may
run behind HII as a transitional embedded execution adapter; it does not own
authority, proof, or product state, and new workflows must not depend directly
on it.

## Unix harness perspective

Treat every harness or executor as a replaceable process with:

- explicit input and output contracts;
- narrow capabilities and declared authority;
- event streams rather than hidden shared state;
- meaningful exit status, cancellation, and time bounds;
- artifacts and receipts that outlive the process;
- no assumption that one model, machine, or provider is permanent.

HII should coordinate existing warm endpoints. It should not add a heavyweight
resident scheduler merely to forward model calls.

## Model roles

Use portable role names at the HII boundary:

- `fast` for routing, extraction, summaries, and quick questions;
- `agent` for multi-step bounded work;
- `review` for deliberate second-pass judgment.

Each authenticated device resolves these roles against its advertised model
catalog. Receipts retain the requested role and the model that actually served
the call.

## Device roles

- Windows PCs and Macs may be full executor nodes after authenticated transport
  and live returned evidence are proven.
- iPhone is initially a capture, notification, approval, and lightweight client
  node rather than an assumed always-on model server.
- Synchronization means typed objects, jobs, results, provenance, and receipts
  converge through HII. It does not mean every device executes every task.

## Promotion gate

Codex stays on top until HII's harness is measurably better for the target work.
Promotion requires repeated comparisons showing HII wins on:

1. task completion quality;
2. time to verified result;
3. tool and executor reliability;
4. authority and secret handling;
5. receipt integrity and recovery;
6. user correction rate;
7. runtime weight and idle overhead.

Roadmap completeness, model size, or a successful health check alone is not a
promotion signal.

## Memory boundary

Codex conversation archives may sync into local HII knowledge when they exclude
hidden reasoning, raw tool payloads, credentials, cookies, and secrets. HII
memory remains local unless a separately authenticated and encrypted sync path
is implemented and proven.
