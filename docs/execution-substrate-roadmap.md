# HII Execution Substrate Roadmap

## Main Intent

HII is not a chatbot, dashboard, or note app with tool hooks.

HII should become a deterministic execution substrate for human intent:

Intent -> decomposition -> prioritization -> execution -> state trail -> real-time visibility

The point is not abstract speed. The point is reducing burnout caused by repeatedly translating intention into steps, tools, and outputs by hand.

## Product Definition

HII should own five jobs:

1. Capture what the user wants.
2. Structure the goal into tasks, requirements, dependencies, and constraints.
3. Execute against tools, APIs, scripts, and local systems.
4. Track what happened, what changed, and where outputs landed.
5. Show the evolving state in real time.

That makes HII a managed state-transformation system, not a conversational wrapper.

## Architectural Reading Of The Current Repo

Current strengths in this repo:

- Deterministic CLI backbone already exists in [src/cli.ts](/Users/ummi/hii/src/cli.ts).
- Tool surfaces already exist for search, browser, space, notes, memory, apps, and codex.
- A persistent document/memory layer already exists through conversations, codex, and Obsidian integration.
- A generation system now exists to track named conceptual milestones through [src/generations.ts](/Users/ummi/hii/src/generations.ts).

Current gaps:

- The agent loop in [src/agent.ts](/Users/ummi/hii/src/agent.ts) still sits too close to direct prompt-response behavior.
- The dashboard in [engine/serve/static/index.html](/Users/ummi/hii/engine/serve/static/index.html) is still observer-oriented instead of execution-oriented.
- There is no explicit task/requirement/dependency model acting as the deterministic middle layer.
- Event emission is implicit and fragmented rather than treated as the primary operational record.

## Concrete Repo-Level Changes

### 1. Add an Intent Runtime Layer

Create a new runtime module that classifies every request into deterministic execution states before any model response:

- `intent.received`
- `intent.decomposed`
- `requirements.derived`
- `plan.validated`
- `tool.routed`
- `execution.started`
- `execution.finished`
- `artifact.recorded`

Suggested files:

- `src/runtime/intent.ts`
- `src/runtime/orchestrator.ts`
- `src/runtime/validators.ts`

This becomes the system of record. LLMs advise; the runtime decides.

### 2. Add A Structured Task And Constraint Model

Right now HII has many actions but no stable internal work object.

Add a task model that can represent:

- goal
- subtask
- requirement
- constraint
- dependency
- artifact
- blocker
- owner
- status transition

Suggested files:

- `src/runtime/tasks.ts`
- `src/types/task.ts`

Without this layer, the user still does the operational middle manually.

### 3. Promote The Event Bus To A First-Class Spine

Every meaningful transition should emit an event and write to a durable store.

The event bus should become the authoritative trail for:

- tool calls
- file mutations
- grounding lookups
- reasoning checkpoints
- artifact creation
- failures
- recoveries

Suggested files:

- `src/runtime/events.ts`
- `src/runtime/event-store.ts`

The dashboard and future graph should render from this stream instead of ad hoc state assembly.

### 4. Rebuild The Main UI As An Execution Shell

The current main UI should stop behaving like a monitoring dashboard and start behaving like an execution surface.

Primary layout:

- command composer
- execution stream
- artifact/output pane
- context drawer

Secondary surfaces:

- graph inspect
- psyche inspect
- runtime inspect
- visual canvas

Main file to replace or heavily refactor:

- [engine/serve/static/index.html](/Users/ummi/hii/engine/serve/static/index.html)

The CLI should remain the execution backbone. The GUI should become a real-time representation and control surface for the same deterministic runtime.

### 5. Treat Generations As Product Milestones, Not Just Versions

Use the generation tracker to mark conceptual shifts in HII’s evolution.

Each generation should capture:

- what changed technically
- what changed conceptually
- what execution model it introduced
- what unresolved gaps remain

Relevant files:

- [src/generations.ts](/Users/ummi/hii/src/generations.ts)
- [docs/generations/registry.json](/Users/ummi/hii/docs/generations/registry.json)

This turns HII history into a design lineage rather than a flat changelog.

## Generation Framing

The current generation should be treated as the transition from:

- local thought-sharpening CLI

to:

- deterministic execution substrate for human intent

That means the next implementation focus is not adding more isolated tools. It is building the deterministic middle layer that owns decomposition, validation, routing, and state.

## Near-Term Build Order

1. Formalize the current baseline as a named generation.
2. Add the intent runtime and event bus.
3. Add the task/constraint/dependency model.
4. Rewire `chat` and `serve` through the orchestrator.
5. Rebuild the dashboard as an execution shell on top of the same event stream.

## One-Sentence Summary

HII should evolve from a powerful local agent CLI into a deterministic, state-aware execution system that converts human intent into realistic, trackable outcomes across work, life, and long-range goals.
