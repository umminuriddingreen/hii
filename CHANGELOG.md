# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [Unreleased]

- Planning and ideas captured via `hii updates add`.

## [0.4.0] — Capability Map

The "sensory layer" release. HII can now *see* the machine and expose what it sees to agents in a structured, safe, agent-readable form.

- Added `hii/capabilities/` subpackage with runtime, app, service, model, workflow, and asset scanners.
- Added `CapabilityMap`, `RuntimeCapability`, `AppCapability`, `ServiceCapability`, `ModelCapability`, `WorkflowCapability`, `AssetCapability`, `ScannerReport`, `PermissionProfile`, `DetectionEvidence` schemas.
- Each capability carries confidence, detection method, scanner source, timestamps, warnings/errors, and a permission profile.
- Added configurable scan paths and allowed roots; default roots are limited to `~/.hii/`, the current repo, and a small set of known project folders. Full-drive scans are explicitly avoided.
- Added local service/model probes: ComfyUI `/object_info`, Ollama `/api/tags`, LM Studio `/models`, Grasshopper MCP TCP probe. Offline services produce `available=False` with high confidence, never a crash.
- Added `~/.hii/capabilities.json` cache with rotation to `~/.hii/previous_capabilities.json` and `~/.hii/capabilities.last_good.json` (last-good never overwritten on partial failure).
- Added `~/.hii/agent_context.md` — auto-generated, agent-readable summary of apps, services, models, workflows, assets, and safety rules.
- Added local JSONL scan traces at `~/.hii/traces/capabilities.jsonl`.
- Added CLI: `hii caps show`, `hii caps refresh`, `hii caps export --format json|llm`, `hii caps diff`.
- Added public Python API: `get_capability_map()`, `refresh_capability_map()`, `export_for_llm()`, `export_as_json()`.
- Skills `arch-design` and `computer-use` are now capability-aware (preflight against the map; actionable messages when required services are offline).
- Bumped version 0.2.0 → 0.4.0.

Secret-safety: env variable values are never read, stored, or exported. Scanners may report the *presence* of sensitive variable names (e.g. `ANTHROPIC_API_KEY`) but values are always `[REDACTED]`.

MCP-readiness: internal structure separates tools, resources, prompts, roots, and services so a future `hii mcp serve` command can expose the map over MCP without restructuring.

## [0.1.0] - Initial scaffold

- CLI commands: ingest, chat, models, config
- Ollama chat + embeddings
- LanceDB vector store (RAG)
- Tools: RAG, shell, web (SerpAPI/DuckDuckGo), academic search (arXiv/OpenAlex/Crossref)
- OA PDF download + ingest
- Obsidian memory logging and recall
- Local HTTP server (/chat, /ingest, /healthz, /graph, /view)
- Vault graph viewer and search

