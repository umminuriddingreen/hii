# Deer Flow Feature Mapping For HII

Source context: Deer Flow positions itself as a super-agent harness with progressive skills/tools loading, scoped sub-agents, sandboxed execution, aggressive context compression, persistent memory, and multi-channel gateway integrations. Reference: <https://github.com/bytedance/deer-flow>

## Priority 1

### 1. Expose managed agents as a first-class HII CLI surface
- Why: HII already has agent registration and execution in `engine/cli.py`, plus delegators in `src/engine/agents.ts` and `engine/agents/delegator.py`, but no main `hii` command surface.
- HII landing spots:
  - `/Users/ummi/hii/src/cli.ts`
  - `/Users/ummi/hii/src/engine/agents.ts`
  - `/Users/ummi/hii/engine/cli.py`
  - `/Users/ummi/hii/README.md`
- Minimal slice:
  - Add `hii agents register|list|run|deactivate`.
  - Reuse the existing TypeScript delegator directly instead of shelling into Python.
  - Surface agent output in a compact CLI format.

### 2. Add scoped sub-task delegation to the orchestrator
- Why: Deer Flow’s strongest capability is structured decomposition into isolated sub-agents with scoped context and merged outputs.
- HII landing spots:
  - `/Users/ummi/hii/src/orchestrator.ts`
  - `/Users/ummi/hii/src/agent.ts`
  - `/Users/ummi/hii/src/engine/taskq.ts`
  - `/Users/ummi/hii/src/store/native_memory.ts`
- Minimal slice:
  - Add a `delegate` tool call shape that can spawn 1..N local sub-tasks.
  - Run sub-tasks through the existing task queue with bounded fan-out.
  - Return structured summaries back into the parent turn.

### 3. Strengthen local sandbox boundaries for execution tools
- Why: Deer Flow distinguishes between secure sandbox execution and local filesystem-only workflows. HII currently offers shell execution but does not model isolation levels strongly.
- HII landing spots:
  - `/Users/ummi/hii/src/tools/shell.ts`
  - `/Users/ummi/hii/src/config.ts`
  - `/Users/ummi/hii/src/orchestrator.ts`
  - `/Users/ummi/hii/AGENTS.md`
- Minimal slice:
  - Introduce execution modes like `host-readonly`, `host-trusted`, `sandbox`.
  - Thread the selected mode into tool policy and prompt instructions.
  - Fail closed when shell is requested in an unsafe mode.

## Priority 2

### 4. Progressive skill loading and category routing
- Why: Deer Flow keeps context lean by loading skills only when needed. HII has a skills registry, but the main chat runtime is not strongly skill-routed yet.
- HII landing spots:
  - `/Users/ummi/hii/engine/skills/registry.py`
  - `/Users/ummi/hii/src/orchestrator.ts`
  - `/Users/ummi/hii/src/cli.ts`
  - `/Users/ummi/hii/engine/skills/seed.py`
- Minimal slice:
  - Add skill search during intent classification.
  - Inject only matched skill summaries into the prompt, not the whole skill universe.
  - Add a visible event like `skill.selected`.

### 5. Context compression for long-running sessions
- Why: Deer Flow explicitly summarizes completed work and offloads intermediate artifacts. HII has memory logging but no active context compaction loop.
- HII landing spots:
  - `/Users/ummi/hii/src/orchestrator.ts`
  - `/Users/ummi/hii/src/store/native_memory.ts`
  - `/Users/ummi/hii/src/memory.ts`
- Minimal slice:
  - Summarize prior tool results after each step into compact state.
  - Keep only a bounded recent window plus compressed summaries in future turns.
  - Store intermediate artifacts in session files rather than replaying full text into context.

### 6. Unified gateway for chat, browser, remote, and external channels
- Why: Deer Flow’s gateway model unifies interactive surfaces and makes agent behavior reusable across environments.
- HII landing spots:
  - `/Users/ummi/hii/src/server.ts`
  - `/Users/ummi/hii/src/remote.ts`
  - `/Users/ummi/hii/public/`
- Minimal slice:
  - Standardize a thread/session envelope across CLI, HTTP, and remote surfaces.
  - Expose agent/task state through one schema.
  - Add server endpoints for agents and tasks instead of keeping them only in the Python engine server.

## Priority 3

### 7. Long-term memory promotion rules
- Why: Deer Flow emphasizes persistent profile and workflow memory with duplicate suppression. HII already stores chat/memory data and can formalize promotion rules.
- HII landing spots:
  - `/Users/ummi/hii/src/store/native_memory.ts`
  - `/Users/ummi/hii/src/memory.ts`
  - `/Users/ummi/hii/src/engine/psyche.ts`
- Minimal slice:
  - Distinguish ephemeral turn memory from durable profile memory.
  - Add dedupe and confidence thresholds for durable writes.
  - Expose `memory promote` and `memory inspect` commands.

### 8. Observability for agent/tool runs
- Why: Deer Flow treats tracing as core infrastructure. HII already emits events and can turn them into a proper execution trace.
- HII landing spots:
  - `/Users/ummi/hii/src/events.ts`
  - `/Users/ummi/hii/src/orchestrator.ts`
  - `/Users/ummi/hii/src/server.ts`
  - `/Users/ummi/hii/public/viewer.js`
- Minimal slice:
  - Persist event streams per turn.
  - Add a lightweight trace viewer endpoint.
  - Include parent/child task IDs for delegated runs.

## Recommended implementation order

1. `hii agents` CLI surface.
2. Scoped delegator tool in `src/orchestrator.ts`.
3. Execution mode policy for shell/sandbox.
4. Progressive skill selection in the runtime.
5. Context compression and event tracing.

## Explicit non-goals for the first pass

- Rebuilding Deer Flow’s full LangGraph runtime.
- Reproducing multi-channel chat integrations before the local CLI/task model is solid.
- Adding external services before the local agent/task substrate is stable.
