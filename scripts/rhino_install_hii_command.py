#!/usr/bin/env python3
"""Install the HII Rhino alias into the active Rhino session via RhinoMCP."""
from __future__ import annotations

import argparse
import json
import os
import sys

AGENT_DIR = os.path.expanduser("~/dev/agent")
if AGENT_DIR not in sys.path:
    sys.path.insert(0, AGENT_DIR)

from rhino_mcp_smoketest import McpStdioClient, _mcp_initialize

DEFAULT_SERVER = os.environ.get("RHINO_MCP_SERVER", "uvx rhinomcp")
DEFAULT_ALIAS = "Hii"
HII_ROOT = os.path.expanduser(os.environ.get("HII_ROOT", "~/hii"))
COMMAND_SCRIPT = os.path.join(HII_ROOT, "scripts", "rhino_hii_command.py")

INSTALL_SCRIPT = """
import rhinoscriptsyntax as rs

alias_name = r"{alias_name}"
script_path = r"{script_path}"
macro = '! _-RunPythonScript "{script_path}"'

if rs.IsAlias(alias_name):
    rs.DeleteAlias(alias_name)
rs.AddAlias(alias_name, macro)
print("OK")
print(alias_name)
print(macro)
"""


def install(alias_name: str, server: str, timeout: float) -> dict:
    code = INSTALL_SCRIPT.format(
        alias_name=alias_name.replace("\\", "\\\\"),
        script_path=COMMAND_SCRIPT.replace("\\", "\\\\"),
    )
    client = McpStdioClient(server.split())
    try:
        _mcp_initialize(client, timeout_s=timeout)
        result = client.request(
            "tools/call",
            params={"name": "execute_rhinoscript_python_code", "arguments": {"code": code}},
            timeout_s=timeout,
        )
        return {
            "alias": alias_name,
            "script": COMMAND_SCRIPT,
            "server": server,
            "result": result,
        }
    finally:
        client.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="Install the HII Rhino command alias via RhinoMCP")
    ap.add_argument("--alias", default=DEFAULT_ALIAS, help="Rhino alias to install")
    ap.add_argument("--server", default=DEFAULT_SERVER, help="RhinoMCP server command")
    ap.add_argument("--timeout", type=float, default=30.0, help="Timeout seconds")
    ns = ap.parse_args()

    try:
        result = install(ns.alias, ns.server, ns.timeout)
        print(json.dumps(result, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
