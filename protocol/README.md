# HII Protocol

<!-- SPDX-License-Identifier: Apache-2.0 -->

**Apache License, Version 2.0.** See [`LICENSE`](./LICENSE) in this directory.

First-party HII source, including the runtime and protocol, is licensed under
Apache-2.0. See the root [`LICENSE`](../LICENSE) and [`NOTICE`](../NOTICE).
Apache-2.0's explicit patent grant applies to the licensed code.

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
- Capability registry + packs — `runtime/capabilities/registry.json`, `runtime/capabilities/packs.json`
- SDK contracts — `docs/hii-sdk-contracts.md`
- Boundary between HII and AII — `docs/aii-hii-boundary.md`

Keep this directory focused on interfaces, schemas, and formats. Third-party
components retain their own licenses and notices.
