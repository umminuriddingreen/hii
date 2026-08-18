# ADR 005: One Surface over the User's Systems and Data

**Status:** Accepted
**Date:** 2026-08-18

## Decision

HII's human-facing product center is one user-owned inference surface for the
user's systems and data across all of their devices and networks.

The surface is spatial and object-native. A live display, file, folder,
application, browser tab, terminal, localhost service, process, model, machine,
GPU, agent, task, result, and receipt should be represented as a typed object or
capability—not only as pixels or copied text. The user addresses those objects
through direct manipulation, selection, text, and voice. Those inputs become
the same bounded intent contract.

The first multi-machine target is an authenticated private Mac/Windows fabric
that can carry independently governed channels for:

- live display frames and audio;
- keyboard, pointer, pen, and other input;
- files, clipboard, and drag-and-drop transfers;
- explicitly exposed localhost services and ports;
- capability discovery, bounded jobs, artifacts, telemetry, and receipts.

The transport may use USB4/Thunderbolt networking or ordinary high-speed IP.
HDMI capture can be a compatibility input, but it is not the core bidirectional
fabric. Transport details remain replaceable beneath the same typed resource and
authority contracts.

## Relationship to CLI-first HII

ADR 004 remains in force. CLI-first assigns deterministic ownership of state,
authority, execution, verification, and receipts to the Rust runtime. It does
not make a terminal the primary human experience.

```text
text + voice + selection + direct manipulation
                    ↓
          typed intent and object scope
                    ↓
        CLI-owned authority and capability
                    ↓
       local or authenticated device executor
                    ↓
         verified artifact and receipt
                    ↓
              surface update
```

The Knowledge Workspace, Context Dock, object graph, and memory remain required.
They provide identity, context, provenance, relationships, history, and proof
for the integrated surface. They are a foundation and first local proof of the
larger product, not a separate final destination.

## Authority and truth boundary

- Observation, planning, browsing, and seeing are read-only by default.
- File mutation, input injection, service exposure, remote execution, transfer,
  publishing, and other consequential work require declared authority and the
  appropriate preview or confirmation.
- Each device link is authenticated, scoped, revocable, and visibly identified.
- Localhost ports are never exposed wholesale; each service is explicitly
  allowed.
- Agents propose changes to user-owned objects. They do not silently reorder,
  publish, overwrite, or define the user's state.
- HII must not claim that it observed or acted on a remote device without a
  working transport, a live executor, and evidence returned by that executor.
- Frames are a useful projection, but pixels alone are not the resource model.

## Implementation sequence

1. Preserve one direct canvas conversation loop with text, selection, and
   visible consequences.
2. Make local system observations, files, services, runs, artifacts, and
   receipts durable typed objects with source identity.
3. Unify voice and text as inputs to the same governed intent path.
4. Establish one authenticated Mac/Windows link and prove discovery, health,
   revocation, and bidirectional control messages.
5. Add low-latency display streaming with latest-frame presentation and measured
   latency, without coupling the canvas to a codec.
6. Add resumable verified file transfer and explicit localhost service proxying.
7. Add job-level resource routing and return results as user-owned artifacts.

Each step must work independently and leave proof. Cross-device transport,
near-native display latency, remote input, service proxying, and compute routing
remain unverified until their respective end-to-end tests run on real machines.

## Non-goals

- A generic remote-desktop clone.
- An opaque chat wrapper over screenshots.
- A decentralized compute marketplace.
- Silent blanket access to every device, file, port, or personal-data source.
- Arbitrary shared GPU memory as a first implementation target.
- A second runtime, authority store, or device-specific product silo.
