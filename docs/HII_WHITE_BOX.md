# White-box HII

**Status:** Founder product principle and operational state contract
**Date:** 2026-08-30

HII is a white-box personal information processor. It should expose the active
state it is registered, permitted, and technically able to observe, while
showing unknown, stale, excluded, and unreachable state explicitly.

```text
input
-> inspectable context
-> explicit interpretation
-> visible proposed action
-> bounded authority
-> execution
-> verification
-> persistent receipt
```

White-box does not mean exposing raw neural-network internals or private
chain-of-thought. It means exposing the operational information that determines
what HII knows and does:

- input and source provenance;
- files, messages, memories, sensors, databases, and selected objects used;
- interpretation, confidence, and supporting evidence;
- current objective, plan, and agent state;
- permissions and authority boundaries;
- models, tools, programs, APIs, and devices invoked;
- proposed actions and exact executed changes;
- verification, errors, artifacts, and receipts;
- retained state, relationships, history, and data use;
- controls to stop, edit, correct, revoke, undo, export, or delete.

## Active-state contract

`hii home --json` is the canonical compact projection for agents and HII
surfaces. Its `activeState` field reports registered domains using a shared
vocabulary:

- `active`: observed work or execution is happening now;
- `attention`: observed state needs human attention;
- `ready`: available with no current activity;
- `idle`: observed and inactive;
- `partial`: only part of the domain is observable or implemented;
- `offline`: a registered observer or executor is unavailable;
- `unknown`: HII lacks enough evidence to make a stronger claim.

Each domain exposes its evidence source, last update, visibility, basis, and
counts. Coverage is part of the result. HII must never turn “not observed” into
“nothing is happening.”

The initial domains are workspace, work, agents, systems, context,
capabilities, authority, evidence, and events. Visual surfaces read this
contract; they do not create another state store.

## Truth boundary

HII does not claim visibility into:

- private or unregistered activity;
- sources outside approved scopes;
- raw model internals or private chain-of-thought;
- remote devices without authenticated transport and a live executor.

A current file, heartbeat, process check, event, artifact, verification result,
or receipt can support an operational claim. A plan, mock, capability listing,
or stale record cannot by itself prove current activity or successful action.

The product standard is:

> If HII can observe it, the state and source should be inspectable. If HII
> cannot observe it, that limit should be inspectable too.
