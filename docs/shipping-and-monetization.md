# HII Shipping And Monetization

## Recommendation

Ship HII with an open-core packaging model:

- Open access:
  - CLI shell, local UX, basic RAG, local note/file search, and public SDK/plugin surfaces.
  - Documentation, examples, and a limited self-hosted path for developers.
- Closed source:
  - Premium runtimes, orchestration services, hosted memory/automation backends, team features, admin controls, billing hooks, and managed model/router infrastructure.
  - Any high-value desktop/runtime bridge that is expensive to reproduce or dangerous to expose.

This gives you distribution and trust from the open layer while keeping monetizable operational leverage in the managed layer.

## Best Business Model

The strongest model is not "closed source only." It is:

- Free local developer edition for adoption.
- Paid Pro seat for solo power users.
- Paid Team/Enterprise plan for shared memory, hosted automations, policy controls, audit, and support.
- Usage-priced hosted runtime for expensive operations:
  - browser/desktop automation
  - remote execution
  - managed search/grounding
  - premium model routing
  - long-running agents and background jobs

The revenue engine should come from hosted execution and coordination, not from charging for the bare CLI.

## Packaging Strategy

Use three product tiers:

1. Community
   - Local CLI.
   - Local RAG/search.
   - Basic integrations.
   - Source available for the core developer surface.

2. Pro
   - Better local UX.
   - Premium packaged runtimes.
   - Signed desktop builds.
   - Faster updates.
   - Optional hosted sync, backups, and cross-device continuity.

3. Team / Enterprise
   - Org policies.
   - Shared memory/workspaces.
   - Role-based access.
   - Audit logs.
   - Managed runtime pools.
   - Private deployment options.

## Closed Source Open Access Model

If the goal is "open access but protect the code and runtimes," the best split is:

- Keep the protocol open.
- Keep the extension points open.
- Keep the premium control plane closed.
- Keep the expensive runtimes closed or remotely hosted.

That means:

- Open:
  - CLI command surface
  - config formats
  - plugin API
  - automation/event schemas
  - local-first developer workflows
- Closed:
  - hosted orchestration backend
  - premium execution runtimes
  - team collaboration backend
  - billing/admin plane
  - model routing heuristics and operational guardrails

This is harder to clone into a business, even if parts of the local client are copied.

## Protecting Code And Runtimes

Protection should assume that local code can be reverse engineered. Build the moat around operation and control, not only binaries.

### Code protection

- Keep premium modules in separate packages/repos.
- Ship signed binaries for packaged runtimes.
- Use license checks for premium local features, but do not rely on them as the primary moat.
- Avoid embedding long-lived secrets in local builds.

### Runtime protection

- Move the highest-value capabilities behind managed services where possible.
- Require authenticated control-plane tokens for premium runtime access.
- Keep model/router configuration, policy logic, and sensitive connectors server-side.
- Rate-limit and meter expensive execution paths.
- Log every privileged runtime action.

### Commercial protection

- Make team workflows depend on hosted coordination.
- Make long-running agents depend on hosted schedulers and state.
- Make premium connectors and enterprise controls server-backed.

The more value comes from live service operation, the less damaging source leakage becomes.

## What Not To Do

- Do not make the entire product closed if growth depends on developer adoption.
- Do not open-source premium operational infrastructure that you plan to monetize directly.
- Do not rely on obfuscation alone to protect local runtimes.
- Do not charge too early for the basic local CLI if you need ecosystem pull.

## Concrete HII Plan

Near-term recommended split for HII:

- Open now:
  - `hii` CLI
  - local menu/TUI
  - local RAG and note search
  - local plugin/skill APIs
  - basic docs and examples
- Closed later:
  - premium hosted memory
  - org/team workspace sync
  - managed browser/desktop automation
  - hosted agent execution queues
  - private model router and policy engine
  - enterprise admin/audit surface

## Immediate Next Steps

1. Separate HII into `core`, `premium-runtime`, and `cloud-control-plane` boundaries.
2. Keep `core` usable alone so adoption is not blocked.
3. Define which features require hosted state versus local state.
4. Add licensing and entitlement checks only to premium modules.
5. Design billing around seats plus metered hosted execution.

## Bottom Line

The best strategy is open-core with closed operational leverage.

Open enough of HII to drive trust, contributions, and adoption. Keep the monetizable runtimes, hosted coordination, and enterprise control surfaces closed. That is the cleanest balance between growth, defensibility, and revenue.
