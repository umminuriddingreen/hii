"""
computer-use — agentic loop that drives the Windows desktop via Claude's vision +
the native `computer_20250124` tool.

Architecture:
    user task ──► [ Claude (vision + computer tool) ]
                       │
                       │ tool_use blocks
                       ▼
              hii.harness.computer_use
                       │  (screenshot, click, type, key, scroll, app launch …)
                       ▼
                  Windows desktop
                       │
                       │ new screenshot + result
                       └────► back to Claude until `end_turn` or `done()`

Usage:
    python -m hii.skills.computer_agent --task "Open Notepad and type 'hello hii'"
    python -m hii.skills.computer_agent --task "..." --max-steps 30 --model claude-sonnet-4-6

Auth:
    Requires ANTHROPIC_API_KEY in env, or a key configured via the anthropic SDK
    default mechanisms.

Safety:
    - --confirm:  pauses before every action and prompts y/N on stdin
    - --dry-run:  logs the planned action chain without touching the desktop
    - FailSafe:   slam the mouse to (0,0) at any time to abort (pyautogui builtin)
    - --max-steps caps the loop length
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anthropic

from hii.harness import computer_use as cu

ARTIFACT_ROOT = Path.home() / ".hii" / "artifacts" / "computer-use"

DEFAULT_MODEL = "claude-sonnet-4-6"

SYSTEM_PROMPT = """You are HII's computer-use agent operating a Windows 11 desktop on behalf of the user.

You have one tool: `computer` (Anthropic's computer_20250124 tool). Use it to take screenshots, move the mouse, click, type, press keys, scroll, etc. The first thing you should usually do is take a screenshot to see the current state.

Capabilities and habits:
- Always re-screenshot AFTER any state-changing action so you see the result before deciding the next step.
- Prefer keyboard shortcuts when they are faster and more reliable than clicking (e.g. Win+R to open Run, Ctrl+S to save, Alt+F4 to close).
- If a window is not in focus, click its title bar or use Alt+Tab before typing.
- If you cannot see what you need, scroll, resize, or take a fresh screenshot — do not guess.
- If an application needs to be launched and you cannot do it via the OS shell, ask: "I need to launch X — should I use Win+R?" and then act.
- Stop when the user's task is completed. Output a final plain-text message describing what you did and the observable end state.
- Refuse if the task is destructive without clear authorization (deleting files, sending messages, modifying shared infra, financial transactions).

Coordinate system: top-left is (0,0). The screenshots you receive may be downscaled for efficiency — the tool internally maps your tool-call coordinates back to physical pixels, so always reason in the resolution of the screenshot you just received."""


@dataclass
class AgentResult:
    ok: bool
    iterations: int
    final_text: str
    artifact_dir: Path
    error: str | None = None
    history: list[dict[str, Any]] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# Tool dispatch — translate Claude's `computer` tool_use into harness calls
# ─────────────────────────────────────────────────────────────────────────────

def _dispatch_computer_action(tool_input: dict[str, Any], dry_run: bool) -> dict[str, Any]:
    """Execute one computer tool_use block. Returns a tool_result content dict.

    Claude's computer_20250124 actions include:
      screenshot, left_click, right_click, middle_click, double_click,
      left_click_drag, mouse_move, type, key, scroll, wait, cursor_position,
      left_mouse_down, left_mouse_up, hold_key, triple_click
    """
    action = tool_input.get("action")
    if dry_run:
        return {"type": "text", "text": f"DRY_RUN: would execute {action} {tool_input}"}

    try:
        if action == "screenshot":
            shot = cu.screenshot()
            return {
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": shot.to_base64()},
            }

        coord = tool_input.get("coordinate")

        if action == "left_click":
            x, y = coord
            cu.mouse_click(x, y, button="left")
        elif action == "right_click":
            x, y = coord
            cu.mouse_click(x, y, button="right")
        elif action == "middle_click":
            x, y = coord
            cu.mouse_click(x, y, button="middle")
        elif action == "double_click":
            x, y = coord
            cu.mouse_double_click(x, y)
        elif action == "triple_click":
            x, y = coord
            cu.mouse_click(x, y, button="left", clicks=3)
        elif action == "left_click_drag":
            x1, y1 = tool_input.get("start_coordinate", coord)
            x2, y2 = tool_input.get("coordinate")
            cu.mouse_drag(x1, y1, x2, y2)
        elif action == "mouse_move":
            x, y = coord
            cu.mouse_move(x, y)
        elif action == "left_mouse_down":
            cu.key_down("__mouse_left__")  # placeholder; pyautogui doesn't expose this cleanly
            return {"type": "text", "text": "left_mouse_down not supported in this harness"}
        elif action == "left_mouse_up":
            return {"type": "text", "text": "left_mouse_up not supported in this harness"}
        elif action == "type":
            cu.type_text(tool_input["text"])
        elif action == "key":
            keys = tool_input["text"].lower().split("+")
            if len(keys) == 1:
                cu.key_press(keys[0])
            else:
                cu.key_combo(keys)
        elif action == "hold_key":
            duration = tool_input.get("duration", 0.5)
            cu.key_down(tool_input["text"])
            cu.wait(duration)
            cu.key_up(tool_input["text"])
        elif action == "scroll":
            direction = tool_input.get("scroll_direction", "down")
            amount = int(tool_input.get("scroll_amount", 3))
            sign = 1 if direction in ("up", "left") else -1
            x, y = coord if coord else (None, None)
            cu.mouse_scroll(sign * amount, x=x, y=y)
        elif action == "wait":
            cu.wait(float(tool_input.get("duration", 1.0)))
        elif action == "cursor_position":
            pos = cu.cursor_position()
            return {"type": "text", "text": f"cursor at x={pos['x']}, y={pos['y']}"}
        else:
            return {"type": "text", "text": f"Unknown action '{action}'"}

        # After every state-changing action, return a fresh screenshot so Claude
        # can verify the result without an extra round-trip.
        shot = cu.screenshot()
        return {
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": shot.to_base64()},
        }

    except cu.pyautogui.FailSafeException:
        raise
    except Exception as exc:
        return {"type": "text", "text": f"ERROR executing {action}: {exc}"}


# ─────────────────────────────────────────────────────────────────────────────
# Agent loop
# ─────────────────────────────────────────────────────────────────────────────

def _confirm(action: str, tool_input: dict[str, Any]) -> bool:
    print(f"\n  ► About to: {action} {json.dumps(tool_input, default=str)}", file=sys.stderr)
    answer = input("    Proceed? [y/N]: ").strip().lower()
    return answer in ("y", "yes")


def run_agent(
    task: str,
    *,
    model: str = DEFAULT_MODEL,
    max_steps: int = 25,
    dry_run: bool = False,
    confirm: bool = False,
    extra_system: str | None = None,
) -> AgentResult:
    run_id = time.strftime("%Y%m%d-%H%M%S")
    artifact_dir = ARTIFACT_ROOT / run_id
    artifact_dir.mkdir(parents=True, exist_ok=True)
    cu.set_action_log_path(artifact_dir / "actions.jsonl")

    width, height = cu.screen_size()
    client = anthropic.Anthropic()

    # Capability summary — compact, no raw JSON, no secrets.
    cap_block = ""
    try:
        from hii import capabilities
        cap = capabilities.get_capability_map()
        apps_on = [a.name for a in cap.apps if a.available][:15]
        svcs_on = [s.name for s in cap.services if s.available]
        cap_block = (
            "\n\n## Machine snapshot (from HII capability map)\n"
            f"- Host: {cap.host.get('os','?')} {cap.host.get('architecture','')} "
            f"on {cap.host.get('hostname','?')} as {cap.host.get('username','?')}\n"
            f"- Apps available: {', '.join(apps_on) if apps_on else '(none detected)'}\n"
            f"- Services online: {', '.join(svcs_on) if svcs_on else '(none)'}\n"
            f"- Allowed scan roots: {', '.join(cap.allowed_roots[:6])}\n"
            "- Safety: read_only by default; .py/.bat/.ps1 require execute_confirm; "
            "destructive ops require destructive_confirm; secret env values are redacted."
        )
    except Exception:
        cap_block = ""

    system_prompt = SYSTEM_PROMPT + cap_block + (("\n\n" + extra_system) if extra_system else "")

    tools = [
        {
            "type": "computer_20250124",
            "name": "computer",
            "display_width_px": width,
            "display_height_px": height,
            "display_number": 1,
        }
    ]

    messages: list[dict[str, Any]] = [{"role": "user", "content": task}]
    history: list[dict[str, Any]] = []

    for step in range(1, max_steps + 1):
        try:
            response = client.messages.create(
                model=model,
                max_tokens=4096,
                system=system_prompt,
                tools=tools,
                messages=messages,
                betas=["computer-use-2025-01-24"],
            )
        except TypeError:
            # Older SDK shape: betas arg not supported on .create — use beta client
            response = client.beta.messages.create(
                model=model,
                max_tokens=4096,
                system=system_prompt,
                tools=tools,
                messages=messages,
                betas=["computer-use-2025-01-24"],
            )
        except Exception as exc:
            return AgentResult(
                ok=False,
                iterations=step,
                final_text="",
                artifact_dir=artifact_dir,
                error=f"Anthropic API error: {exc}",
                history=history,
            )

        assistant_blocks = response.content
        messages.append({"role": "assistant", "content": [b.model_dump() for b in assistant_blocks]})
        history.append({"step": step, "stop_reason": response.stop_reason, "blocks": [b.model_dump() for b in assistant_blocks]})

        # Surface assistant text to stderr so the user sees progress
        for block in assistant_blocks:
            if block.type == "text" and block.text.strip():
                print(f"[step {step}] {block.text}", file=sys.stderr, flush=True)

        if response.stop_reason == "end_turn":
            final_text = "\n".join(b.text for b in assistant_blocks if b.type == "text")
            (artifact_dir / "history.json").write_text(json.dumps(history, indent=2, default=str))
            return AgentResult(
                ok=True, iterations=step, final_text=final_text, artifact_dir=artifact_dir, history=history
            )

        if response.stop_reason != "tool_use":
            (artifact_dir / "history.json").write_text(json.dumps(history, indent=2, default=str))
            return AgentResult(
                ok=False,
                iterations=step,
                final_text="",
                artifact_dir=artifact_dir,
                error=f"Unexpected stop_reason: {response.stop_reason}",
                history=history,
            )

        # Execute every tool_use block in this turn and build a tool_result reply
        tool_results: list[dict[str, Any]] = []
        for block in assistant_blocks:
            if block.type != "tool_use":
                continue
            tool_input = block.input or {}
            action = tool_input.get("action", "?")
            print(f"  → tool_use[{block.name}] {action} {json.dumps({k: v for k, v in tool_input.items() if k != 'text'}, default=str)}", file=sys.stderr)
            if confirm and not _confirm(action, tool_input):
                content = {"type": "text", "text": "User declined this action."}
            else:
                content = _dispatch_computer_action(tool_input, dry_run=dry_run)
            tool_results.append({"type": "tool_result", "tool_use_id": block.id, "content": [content]})

        messages.append({"role": "user", "content": tool_results})

    (artifact_dir / "history.json").write_text(json.dumps(history, indent=2, default=str))
    return AgentResult(
        ok=False,
        iterations=max_steps,
        final_text="",
        artifact_dir=artifact_dir,
        error=f"Max steps ({max_steps}) reached without end_turn",
        history=history,
    )


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="computer-use", description="HII computer-use agent (Claude vision + Windows desktop)")
    p.add_argument("--task", required=True, help="Natural-language task for the agent")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--max-steps", type=int, default=25)
    p.add_argument("--dry-run", action="store_true", help="Plan actions without touching the desktop")
    p.add_argument("--confirm", action="store_true", help="Prompt y/N before every action")
    p.add_argument("--extra-system", default=None, help="Additional system-prompt context")
    args = p.parse_args(argv)

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print(json.dumps({"ok": False, "error": "ANTHROPIC_API_KEY not set"}), file=sys.stderr)
        return 2

    result = run_agent(
        task=args.task,
        model=args.model,
        max_steps=args.max_steps,
        dry_run=args.dry_run,
        confirm=args.confirm,
        extra_system=args.extra_system,
    )
    print(json.dumps({
        "ok": result.ok,
        "iterations": result.iterations,
        "final_text": result.final_text,
        "artifact_dir": str(result.artifact_dir),
        "error": result.error,
    }, indent=2))
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
