Add drawing tools

Better import export mechnims


Native local image generation

pinterest integration as well as cosmos

To import your inspiration from other services


Create a native hii browser users can either choose between firefox or chromium


Once I have these features start shooting product demos and create consultatoins


---

## Positioning decision — 2026-08-13: sensors, not capture

OpenAI shipped Computer History (interaction event stream → local Markdown
memories under `~/.codex/memories/` → source resolution → repeated-workflow
detection → skills/automations). That commoditizes generic activity capture.

**Killed:** any first-party generic "what did I do on my Mac?" capture engine.
Do not build it, do not maintain a partial version of it. It is now a platform
primitive and the engineering does not pay for itself.

**Replaces it — sensor adapters.** Thin, well-specified ingest paths that turn
someone else's capture into HII graph objects:

- Computer History / `~/.codex/memories/` reader
- Claude history reader
- browser, terminal, filesystem, Git
- Apple app data (already have `apple-context.py`)

**Where the engineering goes instead** — the layer no incumbent can be neutral
about: intent, Operational Graph, capability registry, authority/policy,
coordination across substrates, verification + receipts, cross-agent continuity.

Full argument in `docs/thesis.md`. Constraint restated for contributors in
`CONTRIBUTING.md`.
