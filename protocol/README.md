# HII Protocol

<!-- SPDX-License-Identifier: Apache-2.0 -->

**Apache License, Version 2.0.** See [`LICENSE`](./LICENSE) in this directory.

This is the open tier of HII. The runtime is source-available under BSL 1.1
(see the root [`LICENSE`](../LICENSE) and [`NOTICE`](../NOTICE)); everything a
third party needs in order to *talk to* HII lives here and is permissively
licensed, with Apache-2.0's explicit patent grant.

Open the interfaces. Control the implementation.

## What belongs here

| Surface | Description |
| --- | --- |
| Object schemas | Operational Graph nodes, edges, and their serialization |
| Capability spec | The capability descriptor + quote format |
| Receipt format | Provenance and verification records for completed work |
| Agent interface | How an agent substrate (Codex, Claude, local, other) is invoked and reports back |
| Plugin/sensor interface | How an external source (Computer History, Codex memories, browser, terminal, Git, filesystem, apps) feeds the graph |

## Current state

The schemas are still authored in place inside the implementation and are
being lifted here incrementally. Until a definition is moved into this
directory, treat its in-tree location as canonical:

- Capability types — `lib/capabilities/types.ts`
- Capability registry + packs — `aii/capabilities/registry.json`, `aii/capabilities/packs.json`
- SDK contracts — `docs/hii-sdk-contracts.md`
- Boundary between HII and AII — `docs/aii-hii-boundary.md`

Anything **moved into `protocol/` is Apache-2.0 from that point on**, and that
relicensing is intentional and one-way. Do not move implementation code here to
make it easier to import — move only interfaces, schemas, and formats.
