# HII Execution Substrate

HII is not a chatbot wrapper, note app, or dashboard shell.

The core framing is:

Intent -> decomposition -> prioritization -> execution -> state trail -> real-time visibility

That makes HII a deterministic execution substrate for human intent.

## What This Means

- The user should express desired state, not manually translate every step.
- HII should own the missing middle:
  - decomposition
  - requirement mapping
  - sequencing
  - execution
  - state tracking
- LLMs can plan and propose, but they should not own routing, permissions, or system truth.
- The deterministic orchestrator is the spine.

## Core Layers

1. Intent Engine
   - Parse what the user wants.
   - Separate goal, constraints, urgency, and success criteria.

2. Operational Middle Layer
   - Turn intent into tasks, dependencies, blockers, and feasibility checks.
   - Collapse ambiguity before execution.

3. Deterministic Orchestrator
   - Own state, permissions, routing, validation, and tool selection.
   - Treat tools as atomic actions, not freeform suggestions.
   - Prefer native CLI and local search surfaces first (`rg`, `rg --files`, local docs, RAG, CLI-native search); fall back to web search only when local sources are insufficient or the user explicitly asks for web grounding.

4. Execution Layer
   - Run scripts, APIs, local tools, browser actions, and system integrations.

5. State Trail
   - Record what happened, what changed, what failed, and where outputs went.

6. 4D View Layer
   - Show where things live, when they changed, what state they are in, and how they moved from intent to outcome.

## Agent Roles To Build Toward

- Intent Agent
  - Extract goal, constraints, and missing facts from the user request.

- Decomposition Agent
  - Build the task graph and identify dependencies.

- Constraint Agent
  - Check feasibility, prerequisites, permissions, and conflicts.

- Routing Agent
  - Map tasks onto tools, profiles, and execution paths.

- Execution Agent
  - Run the selected actions and collect outputs.

- State Agent
  - Persist transitions, artifacts, and unresolved work.

- Visibility Agent
  - Surface the current state in a way that reduces cognitive load.

These should operate under a deterministic orchestrator instead of acting as independent controllers.

## Product Implications

- CLI is the execution backbone, not the final product.
- GUI is the representation and spatial judgment layer.
- Profiles should be swappable by domain.
- The core should stay universal:
  - task model
  - state model
  - permissions
  - routing
  - execution rules

## Generation Framing

HII should track its own generations as it evolves from:

1. Local thought-sharpening CLI
2. Deterministic intent-to-execution substrate
3. State-aware 4D execution engine
4. Goal-realization system

Each generation should preserve:

- the working code snapshot
- the architectural framing
- the state of the product at that moment
- what changed relative to the prior generation
