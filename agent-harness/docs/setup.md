# Setup Guide

This guide gets a fresh system ready for the unified harness.

## 1. Install core tools

- Python 3.11 or newer
- Rhino 8 with Grasshopper
- ComfyUI
- A shell that can launch `hii` from this repo

## 2. Install the harness

```bash
cd ~/hii/agent-harness
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip setuptools wheel
pip install -e .
```

If the target machine is offline or restricted, make sure the environment already has `setuptools` and `wheel` available before running the editable install.

If you want Codex or Claude to launch the same environment every time, point their MCP `command` at the venv-installed executable.

## 3. Configure environment variables

Start from [`.env.example`](/Users/ummi/hii-agent-harness/.env.example) or [examples/hii-agent-harness.env](/Users/ummi/hii-agent-harness/examples/hii-agent-harness.env).

Minimum values:

```bash
export COMFYUI_URL=http://127.0.0.1:8188
export GRASSHOPPER_MCP_HOST=127.0.0.1
export GRASSHOPPER_MCP_PORT=8080
```

Useful optional values:

- `GRASSHOPPER_MCP_TIMEOUT_S`
- `GRASSHOPPER_MCP_CONNECT_RETRIES`
- `GRASSHOPPER_MCP_RETRY_BACKOFF_S`
- `GRASSHOPPER_MCP_MAX_RESPONSE_BYTES`
- `GRASSHOPPER_MCP_CAP_CACHE`
- `HII_AGENT_HARNESS_COMMAND`

## 4. Configure ComfyUI

Set `COMFYUI_URL` if ComfyUI is not running on `http://127.0.0.1:8188`.

Quick check:

```bash
hii harness comfy status
```

## 5. Configure Rhino and Grasshopper

You need a compiled and loadable `GH_MCP.gha` plugin in Rhino/Grasshopper.

If you have source for the plugin:

1. Open the plugin solution in the Rhino/Grasshopper build environment.
2. Build the project for the target Rhino version.
3. Copy the resulting `.gha` into the Grasshopper libraries folder.
4. Restart Rhino and confirm the component loads.

If you already have a compiled plugin:

1. Copy `GH_MCP.gha` into the Grasshopper libraries folder.
2. Open Rhino and verify the component is available on the Grasshopper canvas.
3. Put the component on the canvas and set it to listen on the same port as `GRASSHOPPER_MCP_PORT`.

Validation:

```bash
hii harness doctor
hii harness grasshopper-mcp
```

## 6. Configure Codex or Claude

Generate MCP config files:

```bash
hii harness harness init --agent codex --output ./examples/codex-mcp.json
hii harness harness init --agent claude --output ./examples/claude-desktop-mcp.json
```

Ready-made examples are included:

- [examples/codex-mcp.json](/Users/ummi/hii-agent-harness/examples/codex-mcp.json)
- [examples/claude-desktop-mcp.json](/Users/ummi/hii-agent-harness/examples/claude-desktop-mcp.json)

Point the generated `command` field at `hii`. The generated args will route through `hii harness ...`.

## 7. Rhino helper script

Generate a Rhino-side helper script that can call the harness from inside Rhino:

```bash
hii harness rhino alias-script --output ./examples/rhino_harness_command.py
```

Or reuse the bundled example:

- [examples/rhino_harness_command.py](/Users/ummi/hii-agent-harness/examples/rhino_harness_command.py)

## 8. Recommended startup sequence

1. Activate the harness environment.
2. Start ComfyUI.
3. Start Rhino and Grasshopper.
4. Load or place `GH_MCP` on the Grasshopper canvas.
5. Launch Codex or Claude with the generated MCP config.
