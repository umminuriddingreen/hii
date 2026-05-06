from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from . import comfyui
from .templates import claude_desktop_config, codex_mcp_config, write_json


def _json_dump(payload: dict) -> None:
    print(json.dumps(payload, indent=2))


def cmd_doctor(args: argparse.Namespace) -> int:
    payload = {
        "package": "hii-harness",
        "version": __version__,
        "comfyui": comfyui.status(args.comfyui_url),
        "grasshopper_bridge": {
            "host": args.grasshopper_host,
            "port": args.grasshopper_port,
            "note": "Run Rhino + Grasshopper with the GH_MCP component listening before using the MCP bridge.",
        },
    }
    _json_dump(payload)
    return 0


def cmd_comfy_status(args: argparse.Namespace) -> int:
    _json_dump(comfyui.status(args.comfyui_url))
    return 0


def cmd_comfy_models(args: argparse.Namespace) -> int:
    try:
        model = comfyui.pick_model(args.comfyui_url, args.model)
        payload = {"comfyui_url": args.comfyui_url, "selected_model": model}
        _json_dump(payload)
        return 0
    except comfyui.ComfyUiError as exc:
        print(str(exc), file=sys.stderr)
        return 1


def cmd_comfy_text2img(args: argparse.Namespace) -> int:
    try:
        result = comfyui.run_text_to_image(
            args.prompt,
            comfyui_url=args.comfyui_url,
            negative_prompt=args.negative_prompt,
            model=args.model,
            width=args.width,
            height=args.height,
            steps=args.steps,
            cfg=args.cfg,
            seed=args.seed,
            batch_size=args.batch_size,
            output_prefix=args.output_prefix,
            wait=not args.no_wait,
        )
        _json_dump(result)
        return 0
    except comfyui.ComfyUiError as exc:
        print(str(exc), file=sys.stderr)
        return 1


def cmd_comfy_workflow(args: argparse.Namespace) -> int:
    try:
        workflow = comfyui.load_workflow(args.workflow)
        if args.image_name:
            workflow = comfyui.inject_image_name(workflow, args.image_name)
        queued = comfyui.queue_workflow(args.comfyui_url, workflow)
        result = {
            "ok": True,
            "comfyui_url": args.comfyui_url,
            "prompt_id": queued["prompt_id"],
            "client_id": queued["client_id"],
        }
        if not args.no_wait:
            result["outputs"] = comfyui.wait_for_outputs(args.comfyui_url, queued["prompt_id"], timeout_s=args.timeout)
        _json_dump(result)
        return 0
    except (comfyui.ComfyUiError, FileNotFoundError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


def cmd_harness_init(args: argparse.Namespace) -> int:
    if args.agent == "codex":
        payload = codex_mcp_config(args.command)
    else:
        payload = claude_desktop_config(args.command)
    target = write_json(args.output, payload)
    print(str(target))
    return 0


def cmd_rhino_alias(args: argparse.Namespace) -> int:
    script = f"""#!/usr/bin/env python3
\"\"\"Rhino helper for HII Harness.\"\"\"
from __future__ import annotations

import os
import shlex
import subprocess
import tempfile

try:
    import rhinoscriptsyntax as rs
except ImportError as exc:
    raise SystemExit("This script must run inside Rhino's Python environment.") from exc

HARNESS_COMMAND = os.environ.get("HII_AGENT_HARNESS_COMMAND", "{args.command}")
DEFAULT_OUTPUT = os.path.join(tempfile.gettempdir(), "hii-agent-harness-rhino-last.txt")


def _prompt() -> str | None:
    prompt = rs.StringBox("Ask HII Harness", "", "HII Harness")
    if prompt is None:
        return None
    prompt = prompt.strip()
    return prompt or None


def _run(prompt: str) -> tuple[int, str, str]:
    command = shlex.split(HARNESS_COMMAND) + ["comfy", "text2img", prompt, "--no-wait"]
    proc = subprocess.run(command, capture_output=True, text=True)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def main() -> None:
    prompt = _prompt()
    if not prompt:
        print("Cancelled.")
        return
    code, stdout, stderr = _run(prompt)
    output = stdout or stderr or "(no output)"
    with open(DEFAULT_OUTPUT, "w", encoding="utf-8") as handle:
        handle.write(output)
    print(output)
    if code != 0:
        rs.MessageBox(f"Command failed. Output saved to {{DEFAULT_OUTPUT}}", 0, "HII Harness")
        return
    rs.MessageBox(output[:1200], 0, "HII Harness")


if __name__ == "__main__":
    main()
"""
    output = Path(args.output).expanduser()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(script, encoding="utf-8")
    print(str(output))
    return 0


def cmd_grasshopper_mcp(args: argparse.Namespace) -> int:
    from .grasshopper_bridge import main as run_grasshopper_bridge

    run_grasshopper_bridge()
    return 0


def build_parser(prog: str = "hii harness") -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=prog)
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    doctor = sub.add_parser("doctor", help="Check local ComfyUI and bridge settings.")
    doctor.add_argument("--comfyui-url", default=comfyui.DEFAULT_COMFYUI_URL)
    doctor.add_argument("--grasshopper-host", default="127.0.0.1")
    doctor.add_argument("--grasshopper-port", type=int, default=8080)
    doctor.set_defaults(func=cmd_doctor)

    comfy = sub.add_parser("comfy", help="ComfyUI helpers.")
    comfy_sub = comfy.add_subparsers(dest="comfy_command", required=True)

    comfy_status = comfy_sub.add_parser("status", help="Check ComfyUI reachability.")
    comfy_status.add_argument("--comfyui-url", default=comfyui.DEFAULT_COMFYUI_URL)
    comfy_status.set_defaults(func=cmd_comfy_status)

    comfy_models = comfy_sub.add_parser("models", help="Resolve or inspect the active checkpoint model.")
    comfy_models.add_argument("--comfyui-url", default=comfyui.DEFAULT_COMFYUI_URL)
    comfy_models.add_argument("--model")
    comfy_models.set_defaults(func=cmd_comfy_models)

    comfy_text2img = comfy_sub.add_parser("text2img", help="Queue a basic text-to-image graph in ComfyUI.")
    comfy_text2img.add_argument("prompt")
    comfy_text2img.add_argument("--comfyui-url", default=comfyui.DEFAULT_COMFYUI_URL)
    comfy_text2img.add_argument("--negative-prompt")
    comfy_text2img.add_argument("--model")
    comfy_text2img.add_argument("--width", type=int, default=1024)
    comfy_text2img.add_argument("--height", type=int, default=1024)
    comfy_text2img.add_argument("--steps", type=int, default=30)
    comfy_text2img.add_argument("--cfg", type=float, default=7.0)
    comfy_text2img.add_argument("--seed", type=int)
    comfy_text2img.add_argument("--batch-size", type=int, default=1)
    comfy_text2img.add_argument("--output-prefix")
    comfy_text2img.add_argument("--no-wait", action="store_true")
    comfy_text2img.set_defaults(func=cmd_comfy_text2img)

    comfy_workflow = comfy_sub.add_parser("workflow", help="Queue a saved ComfyUI workflow JSON.")
    comfy_workflow.add_argument("workflow")
    comfy_workflow.add_argument("--comfyui-url", default=comfyui.DEFAULT_COMFYUI_URL)
    comfy_workflow.add_argument("--image-name", help="Inject this file name into all LoadImage nodes.")
    comfy_workflow.add_argument("--timeout", type=int, default=180)
    comfy_workflow.add_argument("--no-wait", action="store_true")
    comfy_workflow.set_defaults(func=cmd_comfy_workflow)

    harness = sub.add_parser("harness", help="Generate agent harness config files.")
    harness_sub = harness.add_subparsers(dest="harness_command", required=True)
    harness_init = harness_sub.add_parser("init", help="Write Codex or Claude MCP config.")
    harness_init.add_argument("--agent", choices=["codex", "claude"], required=True)
    harness_init.add_argument("--command", default="hii")
    harness_init.add_argument("--output", required=True)
    harness_init.set_defaults(func=cmd_harness_init)

    rhino = sub.add_parser("rhino", help="Rhino integration helpers.")
    rhino_sub = rhino.add_subparsers(dest="rhino_command", required=True)
    rhino_alias = rhino_sub.add_parser("alias-script", help="Generate a Rhino Python helper script.")
    rhino_alias.add_argument("--command", default="hii harness")
    rhino_alias.add_argument("--output", required=True)
    rhino_alias.set_defaults(func=cmd_rhino_alias)

    grasshopper = sub.add_parser("grasshopper-mcp", help="Run the embedded Grasshopper MCP bridge over stdio.")
    grasshopper.set_defaults(func=cmd_grasshopper_mcp)

    return parser


def main(argv: list[str] | None = None, *, prog: str = "hii harness") -> int:
    parser = build_parser(prog=prog)
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
