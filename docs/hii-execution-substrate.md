# HII Execution Substrate

## Core framing

HII is not a chatbot, dashboard, note app, or whiteboard. Those can exist inside it, but the core system is:

`intent -> decomposition -> prioritization -> execution -> state trail -> visibility`

The product definition is:

`HII = a deterministic execution substrate for human intent`

That means the system owns the operational middle layer between desire and outcome:

- capture intent
- infer requirements and constraints
- decompose goals into executable work
- route work through deterministic rules and tools
- track state transitions and outputs
- expose the live state trail back to the user

## Architectural implications for this repo

### 1. Deterministic orchestrator has to become the spine

The current CLI and server are useful surfaces, but the system still leans on the model loop too early. The orchestrator should own:

- session state
- intent classification
- tool permissions
- execution routing
- event emission
- artifact registration

When HII is answering questions or searching for context, it should try native CLI and local retrieval first (`rg`, `rg --files`, local docs, RAG, CLI-native search surfaces). Web providers should be the fallback when local sources are insufficient or the user explicitly requests web grounding.

LLMs should plan and propose. They should not own state authority.

### 2. UI has to become execution-first

The dashboard should stop behaving like a control room made of parallel widgets. The primary surface should be:

- command composer
- execution stream
- artifact pane
- context drawer

Graph, psyche, bridge traffic, and debug views should move behind an inspect layer.

### 3. Goals need a structured state model

HII should not treat goals as prompts. It should treat them as state transformations with:

- desired state
- current state
- requirements
- constraints
- feasibility signals
- dependency graph
- execution path

This is the difference between answering “I want a Tesla” and operationalizing the path to sustainable ownership.

### 4. Profiles belong at the edge, not in the core

The core remains stable:

- orchestrator
- task model
- tool registry
- event bus
- memory/state store

Domain specialization should load as profiles:

- architecture
- life admin
- finance
- office
- research

### 5. Every generation should move HII toward a 4D execution engine

The long-term system needs live visibility across:

- where outputs live
- when they changed
- what state they are in
- how they flowed from intent to artifact

The event trail is not telemetry garnish. It is product infrastructure.

## Immediate repo-level changes

### Generation 0

Stabilize snapshotting and generation tracking so the system can preserve major evolutionary states without relying on git hygiene.

### Generation 1

Introduce a deterministic orchestrator module with typed intent classification and typed execution events.

### Generation 2

Refactor the UI into an execution shell driven by the event stream rather than dashboard panels.

### Generation 3

Add a goal/task/constraint model so HII can manage realistic state transitions instead of single prompts.

### Generation 4

Add profile loading and tool capability boundaries so the same core can support multiple domains safely.

## Proposed event vocabulary

These event types are enough to start making HII observable as an execution substrate:

- `intent.received`
- `intent.classified`
- `goal.defined`
- `task.created`
- `constraint.detected`
- `grounding.started`
- `grounding.finished`
- `tool.selected`
- `tool.started`
- `tool.finished`
- `artifact.created`
- `state.updated`
- `response.completed`
- `blocker.detected`

## Product test

HII is aligned only if the user can provide intent and the system absorbs the operational burden.

If the user still has to do decomposition, sequencing, bookkeeping, and state tracking manually, HII is still an assistant wrapper.
