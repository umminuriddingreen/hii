# HII Thesis

> **HII is personal intelligence made spatial: the user-owned information,
> context, and control plane for human–agent computing.**

Not "HII remembers what you do."

## Why the sharpening

The wedge HII started from — capture what happens on your computer, build memory
from it, hand that memory to an AI so it can resume your work — is being turned
into a platform primitive. OpenAI's Computer History records interaction events
across allowed apps and sites, renders a timeline, distills local Markdown
memories under `~/.codex/memories/`, resolves the original source when deeper
context is needed, and detects repeated workflows to propose as skills or
automations.

That is genuine validation: *event stream → memories → source resolution →
repeated workflows → skills → automations* is remarkably close to the shape HII
had been converging on. It is also a clear signal. **Memory capture cannot be the
moat.** Every major vendor will ship it, each wired to its own agent.

So HII moves up the stack. It does not compete for mouse clicks or ask people
to compress their world into prompts. It gives their existing material a shared
space in which it can become connected, understandable, actionable, and
durable.

Chat is one gesture, not the organizing model. People can point, select, move,
draw, type, speak, group, revise, and approve. Models infer and propose;
CLI-owned capabilities act within bounds; receipts show what changed.

## The architecture

```
                    ┌─ Computer History
                    ├─ Codex memories (~/.codex/memories/)
                    ├─ Claude history
                    ├─ browser
Human ─ intent ──►  ├─ terminal            ──►  HII GRAPH
                    ├─ filesystem
                    ├─ Git
                    └─ apps / services
                                                    │
                                          context resolution
                                                    │
                                          policy / authority
                                                    │
                                            coordination
                                                    │
                            Codex · Claude · Hermes · local · other
                                                    │
                                     verified work + receipts
                                                    │
                                       reusable capabilities
```

Everything on the left is a **sensor**. Sensors are commodity, they are
replaceable, and new ones will keep arriving. The graph is not a database
diagram users must operate; it appears as meaningful source-backed objects,
relationships, jobs, artifacts, and receipts on a shared work surface. HII's
job is everything below and around that living object world.

The working loop is:

```text
perceive → understand → propose or act → verify → remember → continue
```

The human-facing grammar is **Look · Do · Delegate**. Authority is a separate
dimension, from observation through reversible change to external or
irreversible commitment. Determinism belongs where the world changes, not in
the way the human must express thought.

## What HII owns

| Layer | Why it is defensible |
| --- | --- |
| **Intent** | What the human actually wants, stated once and carried across tools and sessions. |
| **Operational Graph** | Canonical, source-linked state. Not a transcript — a graph you can resolve, query, and prove against. |
| **Capability registry** | What can actually run here, right now, checked *before* an agent narrates that it did something. |
| **Authority & policy** | Grants, risk, and permission decide whether work runs at all. Irreversible actions need explicit authority. |
| **Coordination** | Many agents and models, one coordinator that stays alive across them. |
| **Verification & receipts** | Provenance for what happened. This is what separates a memory product from an agent operating system. |
| **Cross-agent continuity** | Switch substrates without losing state. Nobody with a flagship agent has an incentive to build this. |

## What HII does not build

**Generic first-party activity capture.** No "what did I do on my Mac?"
recorder. That layer is becoming an OS primitive and the engineering does not
pay for itself. Every hour there goes into sensor *adapters* instead — thin,
well-specified ingest paths that turn someone else's capture into HII graph
objects.

This is a standing constraint, not a phase. See `CONTRIBUTING.md`.

## Why a neutral control plane can exist

OpenAI's architecture ultimately centers ChatGPT and Codex — Computer History
literally spins up Codex sessions to transform events into memories. Anthropic
centers Claude. Google centers Gemini. Each is structurally incapable of being
neutral about which agent sits at the middle, because each *is* the agent at the
middle.

HII centers the human, and treats Codex, Claude, Hermes, and local models as
interchangeable execution substrates. That is the position no incumbent can
occupy without undercutting its own product.

Concretely, that means HII must be excellent at interoperability, provenance,
permissions, and continuity — and must ship its protocol as genuinely open
(Apache-2.0, `protocol/`) even while the runtime stays source-available under
BSL. Open the interfaces. Control the implementation. See `NOTICE`.

## Position on the launch

OpenAI did not build HII. OpenAI shipped an excellent HII sensor.
