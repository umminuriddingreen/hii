# ADR 006: Selective Hermes behavior in HII

Status: accepted implementation scope for continuous messaging
Date: 2026-09-27

## Decision

Integrate useful agent interaction behavior into the existing HII runtime.
Keep HII CLI authority, scoped tools, verification, receipts, and conversation
storage as the ownership boundary.

For this slice, the useful behavior is accepting additional user messages while
a turn is running, processing them in order, and distinguishing explicit Stop
from a follow-up message. Preserve accepted text and show its execution state.
Follow-ups are queued turns; they do not interrupt a tool already executing.

## Source reviewed

The installed NousResearch Hermes source at commit
`cda237464a51739e55ab13946a00272e548443e5` implements separate interrupt,
steering, and redirect slots in `agent/interrupt_control.py`. This review informs
the interaction contract. This slice copies no upstream implementation and
adds no Hermes runtime dependency.

HII already provides terminal steering and queuing in
`cli/src/conversation.rs`. The personal workspace must expose continuous input
through the existing `hii agents chat` contract and CLI-governed run adapter.
The `--engine hermes` compatibility spelling currently selects the Rust engine;
it must not be presented as proof that Hermes Python executes a run.

## Scope

Retain bounded conversation context, ordered follow-ups, explicit cancellation,
visible events, and durable HII records. Future upstream imports require a
scoped review, source provenance and license attribution, and proof against
the same authority boundary.

Whole-runtime vendoring, gateway integrations, external credentials, scheduler
installation, provider defaults, and Hermes-owned state are outside this slice.
