# HII Agent Harness

The HII harness bundles the Rhino/Grasshopper MCP bridge, ComfyUI helpers, and agent-harness config generation into one integrated HII subsystem.

It is designed to replace machine-specific scripts with a portable CLI that can be installed on a new system and then connected to Codex or Claude through MCP.

## Quick Start

1. Install Python 3.11 or newer.
1. Install Rhino 8 and Grasshopper.
1. Install or build the `GH_MCP` Grasshopper plugin, then load it into Rhino.
1. Install ComfyUI and confirm it is reachable on `http://127.0.0.1:8188`.
1. Install this package with `pip install -e .`.
1. Read [`docs/setup.md`](./docs/setup.md) for the full environment checklist.
1. Generate Codex or Claude MCP config from `examples/` or with `hii harness harness init`.

## What It Includes

- A built-in Grasshopper MCP bridge exposed over stdio for agent harnesses.
- ComfyUI helpers for health checks, model resolution, text-to-image runs, and saved workflow execution.
- Ready-to-write config snippets for Codex and Claude Desktop.
- A generated Rhino Python helper script so Rhino can invoke the harness cleanly.

## Install

```bash
cd ~/hii/agent-harness
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip setuptools wheel
pip install -e .
```

The native command is `hii harness ...`. `hii-agent-harness` remains available as a compatibility wrapper.

If you are working in a locked-down or partially offline environment, use a Python environment that already has `setuptools` available before running the editable install.

## Basic Usage

Check local status:

```bash
hii harness doctor
hii harness comfy status
```

Run the Grasshopper MCP server:

```bash
hii harness grasshopper-mcp
```

Queue a simple ComfyUI generation:

```bash
hii harness comfy text2img "conceptual tower model with soft studio lighting"
```

Run a saved ComfyUI workflow:

```bash
hii harness comfy workflow ./workflow.json --image-name rhino_capture.png
```

Generate MCP config for Codex:

```bash
hii harness harness init --agent codex --output ./examples/codex-mcp.json
```

Generate MCP config for Claude Desktop:

```bash
hii harness harness init --agent claude --output ./examples/claude-desktop-mcp.json
```

Generate a Rhino-side helper script:

```bash
hii harness rhino alias-script --output ./examples/rhino_harness_command.py
```

## Rhino And Grasshopper Setup

The harness expects a Grasshopper component that can accept MCP socket requests. The portable package includes the bridge and the helper scripts, but the Rhino-side plugin itself still needs to be present.

If you already have a compiled `GH_MCP.gha`, place it in Grasshopper's library folder and load it in Rhino. If you have source for the plugin, build it with the Rhino SDK / Grasshopper plugin toolchain for your target platform, then copy the compiled `.gha` into the Grasshopper libraries directory.

Recommended install flow:

```bash
hii harness grasshopper-mcp
hii harness doctor
```

If `doctor` reports that Grasshopper is unreachable, verify that Rhino is open, the `GH_MCP` component is on the canvas, and the component is listening on the port configured by `GRASSHOPPER_MCP_PORT`.

## Codex And Claude Setup

Create an MCP config that points to the installed harness binary:

```bash
hii harness harness init --agent codex --output ./examples/codex-mcp.json
hii harness harness init --agent claude --output ./examples/claude-desktop-mcp.json
```

Then update the generated `command` field if your harness lives somewhere other than the current shell session's venv.

For Codex, use the generated JSON as the MCP server entry in the agent config.
For Claude Desktop, merge the generated JSON into the desktop app's MCP configuration file.

## Environment Setup

Set these variables before launching the harness if you need non-default paths:

- `COMFYUI_URL` for the ComfyUI HTTP endpoint.
- `GRASSHOPPER_MCP_HOST` for the Grasshopper listener host.
- `GRASSHOPPER_MCP_PORT` for the Grasshopper listener port.
- `GRASSHOPPER_MCP_TIMEOUT_S` for socket timeouts.
- `GRASSHOPPER_MCP_CONNECT_RETRIES` for connection retry count.
- `GRASSHOPPER_MCP_RETRY_BACKOFF_S` for retry delay.
- `GRASSHOPPER_MCP_MAX_RESPONSE_BYTES` for bridge response size limits.
- `GRASSHOPPER_MCP_CAP_CACHE` for cached Grasshopper command support.
- `HII_AGENT_HARNESS_COMMAND` for the Rhino helper script's CLI command.

## Repo Layout

- [`src/hii_agent_harness/`](./src/hii_agent_harness) — Python CLI and MCP bridge.
- [`vendor/rhino/`](./vendor/rhino) — vendored `rhinomcp` package and `GH_MCP.gha` ready to drop into Rhino.
- [`rhino/`](./rhino) — Rhino-side scripts, reference prompt chains, and SKILL.md bundles imported from `~/rhino-integration`.
- [`skills/`](./skills) — harness-relevant skill manifests copied from `~/.hii/skills/`.
- [`examples/`](./examples) — ready-made Codex/Claude MCP configs and the Rhino helper script.
- [`CENTRALIZATION_LOG.md`](./CENTRALIZATION_LOG.md) — what was imported from where (breadcrumbs for collaborators).

## Reference

- [`docs/setup.md`](./docs/setup.md) for the full install checklist.
- [`docs/rhino-plugin-build.md`](./docs/rhino-plugin-build.md) for plugin build and install notes.

## Notes

- Grasshopper support expects Rhino + Grasshopper to be running with your GH_MCP component listening on a TCP port.
- ComfyUI support assumes a reachable ComfyUI HTTP server; the default URL is `http://127.0.0.1:8188`.
- The package removes hardcoded local paths from the original scripts so you can move it to another machine and reconfigure it with env vars instead.
