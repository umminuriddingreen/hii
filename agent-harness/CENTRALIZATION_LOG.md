# Centralization Log

Breadcrumbs for anyone else working in this repo. This file records assets that were imported from elsewhere on the originating machine so the harness can be installed on a new system from a single tree.

## 2026-04-14 — initial centralization

Imported into this repo; originals left in place on the source machine.

### Plugin binaries → `vendor/rhino/`

| Destination | Source |
|---|---|
| `vendor/rhino/rhinomcp/` (incl. `0.2.0/`, `0.2.1/`, `manifest.txt`) | `~/Library/Application Support/McNeel/Rhinoceros/packages/8.0/rhinomcp/` |
| `vendor/rhino/grasshopper/GH_MCP.gha` | `~/Library/Application Support/McNeel/Rhinoceros/8.0/Plug-ins/Grasshopper (b45a29b1-4343-4035-989e-044e8580d9cf)/Libraries/GH_MCP.gha` |

Install targets on a fresh machine are documented in [docs/rhino-plugin-build.md](docs/rhino-plugin-build.md).

### Rhino integration → `rhino/`

From `~/rhino-integration/`:

- `rhino_scripts/refine_mesh.py` → `rhino/scripts/refine_mesh.py`
- `scripts/{comfyui_generate,convert_to_3dm,generate_2d_inputs}.py` → `rhino/scripts/`
- `chains/chain{1..5}/` → `rhino/chains/` (reference prompt/image chains)
- `skills/{comfyui-generate,rhino-explain-geometry,rhino-import-comfyui,rhino-sketch-building}/` → `rhino/skills/`
- `RESEARCH_REPORT.md` → `rhino/RESEARCH_REPORT.md`

### Skill manifests → `skills/`

Selected harness-relevant manifests copied from `~/.hii/skills/`:

- `bootstrap-hii-agent-harness.json`
- `comfyui-{mcp-start,start,status}.json`, `wm-comfyui.json`
- `direct-3d-{install,triposr}.json`, `image-to-geometry.json`, `potree-viewer.json`
- `ollama-rhino-agent.json`, `rhino-agent.json`, `rhino-install-hii-command.json`
- `rhino-mcp-test.json`, `rhino-viewport-capture.json`

Runtime state (bridge logs, vault, conversations, the full skill set) still lives under `~/.hii/` on the source machine and is **not** mirrored here.

## Repository layout

- `~/hii/` is the single codebase.
- The former sibling project `~/hii-agent-harness` now lives at `~/hii/agent-harness/`.
- `~/hii-agent-harness` remains as a symlink to `~/hii/agent-harness` for compatibility with older commands and links.

## Deliberately not imported

- Third-party Grasshopper libraries (LunchBox, Weaverbird, Alpaca4d, etc.) — public plugins; install via Yak/PackageManager rather than vendoring.
- `~/Documents/ComfyUI`, `~/rhino_guides_pdfs` — bulky assets, not needed for installing the harness.
- `~/mcp/mcp-searxng` — unrelated MCP server.

## Conventions

- Put new vendored binaries under `vendor/<tool>/…` and record the source path here.
- Prefer adding to `rhino/scripts/` or `skills/` over creating new top-level dirs.
- If you remove or replace something imported above, update this log in the same commit.
