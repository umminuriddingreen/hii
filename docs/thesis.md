# HII Thesis

> **HII is the user-owned context and control plane for human–agent computing.**

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

So HII moves up the stack. It does not compete for mouse clicks.

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
replaceable, and new ones will keep arriving. HII's job is everything below the
graph.

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
