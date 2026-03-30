#!/usr/bin/env python3
"""Capture Rhino viewport as PNG via RhinoMCP."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

# Allow importing McpStdioClient from the agent directory
AGENT_DIR = os.path.expanduser("~/dev/agent")
if AGENT_DIR not in sys.path:
    sys.path.insert(0, AGENT_DIR)

from rhino_mcp_smoketest import McpStdioClient, _mcp_initialize

DEFAULT_OUTPUT = "/tmp/hii-rhino-capture.png"
DEFAULT_SERVER = os.environ.get("RHINO_MCP_SERVER", "uvx rhinomcp")

CAPTURE_SCRIPT = """
import Rhino
import System.Drawing

doc = Rhino.RhinoDoc.ActiveDoc
view = doc.Views.ActiveView
size = System.Drawing.Size({width}, {height})
bmp = view.CaptureToBitmap(size)
bmp.Save(r"{output}", System.Drawing.Imaging.ImageFormat.Png)
bmp.Dispose()
print("OK")
"""


def capture(width: int, height: int, output: str, server: str, timeout: float) -> dict:
    code = CAPTURE_SCRIPT.format(width=width, height=height, output=output.replace("\\", "\\\\"))
    client = McpStdioClient(server.split())
    try:
        _mcp_initialize(client, timeout_s=timeout)
        result = client.request(
            "tools/call",
            params={"name": "execute_rhinoscript_python_code", "arguments": {"code": code}},
            timeout_s=timeout,
        )
        return {"path": output, "width": width, "height": height, "result": result}
    finally:
        client.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="Capture Rhino viewport as PNG via RhinoMCP")
    ap.add_argument("--width", type=int, default=1920, help="Capture width in pixels")
    ap.add_argument("--height", type=int, default=1080, help="Capture height in pixels")
    ap.add_argument("--output", default=DEFAULT_OUTPUT, help="Output PNG path")
    ap.add_argument("--server", default=DEFAULT_SERVER, help="MCP server command")
    ap.add_argument("--timeout", type=float, default=30.0, help="Timeout seconds")
    ns = ap.parse_args()

    try:
        result = capture(ns.width, ns.height, ns.output, ns.server, ns.timeout)
        print(json.dumps(result, indent=2))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
