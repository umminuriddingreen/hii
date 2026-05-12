"""
computer_use — Windows-native actuator primitives for HII computer-use agents.

This module is pure: it has no LLM dependency and exposes only side-effect
primitives (screenshot, mouse, keyboard, app launch, window focus). The agent
loop lives in `hii.skills.computer_agent` and calls these functions in
response to Claude tool-use blocks.

All coordinates are in *physical* screen pixels. The caller is responsible for
mapping logical/scaled coords if the display has DPI scaling.

Safety:
  - pyautogui's failsafe is enabled: slamming the mouse into the top-left
    corner aborts the agent (raises FailSafeException).
  - All actions log to ~/.hii/artifacts/computer-use/<run_id>/actions.jsonl
    when `set_action_log_path(path)` is called by the agent.
"""

from __future__ import annotations

import base64
import ctypes
import io
import json
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from PIL import ImageGrab

import pyautogui

# Enable failsafe: move mouse to (0,0) to abort
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.05  # small pause between pyautogui calls for stability

# DPI-aware on Windows so coords match what we see
if os.name == "nt":
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# Action logging (opt-in)
# ─────────────────────────────────────────────────────────────────────────────

_ACTION_LOG: Path | None = None


def set_action_log_path(path: Path | str | None) -> None:
    """Enable JSONL action logging. Pass None to disable."""
    global _ACTION_LOG
    if path is None:
        _ACTION_LOG = None
        return
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    _ACTION_LOG = p


def _log(action: str, **details: Any) -> None:
    if _ACTION_LOG is None:
        return
    entry = {"ts": time.time(), "action": action, **details}
    with _ACTION_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, default=str) + "\n")


# ─────────────────────────────────────────────────────────────────────────────
# Screen / screenshot
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class Screenshot:
    png_bytes: bytes
    width: int
    height: int

    def to_base64(self) -> str:
        return base64.b64encode(self.png_bytes).decode("ascii")

    def save(self, path: Path | str) -> Path:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(self.png_bytes)
        return p


def screen_size() -> tuple[int, int]:
    w, h = pyautogui.size()
    return int(w), int(h)


def screenshot(region: tuple[int, int, int, int] | None = None, max_dim: int | None = 1568) -> Screenshot:
    """Capture the screen (or a region: (x1, y1, x2, y2) in PIL bbox form).

    `max_dim` downscales so the longest side ≤ max_dim. Claude's vision input
    is more efficient and faster on smaller images; 1568 is the recommended
    cap. Pass None to disable.
    """
    img = ImageGrab.grab(bbox=region, all_screens=False)
    if max_dim and max(img.size) > max_dim:
        ratio = max_dim / max(img.size)
        new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
        img = img.resize(new_size)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    shot = Screenshot(png_bytes=buf.getvalue(), width=img.size[0], height=img.size[1])
    _log("screenshot", region=region, width=shot.width, height=shot.height, bytes=len(shot.png_bytes))
    return shot


# ─────────────────────────────────────────────────────────────────────────────
# Mouse
# ─────────────────────────────────────────────────────────────────────────────

Button = Literal["left", "middle", "right"]


def mouse_move(x: int, y: int, duration: float = 0.15) -> None:
    pyautogui.moveTo(x, y, duration=duration)
    _log("mouse_move", x=x, y=y)


def mouse_click(x: int | None = None, y: int | None = None, button: Button = "left", clicks: int = 1) -> None:
    if x is not None and y is not None:
        pyautogui.click(x=x, y=y, button=button, clicks=clicks, interval=0.08)
    else:
        pyautogui.click(button=button, clicks=clicks, interval=0.08)
    _log("mouse_click", x=x, y=y, button=button, clicks=clicks)


def mouse_double_click(x: int, y: int, button: Button = "left") -> None:
    mouse_click(x, y, button=button, clicks=2)


def mouse_drag(x1: int, y1: int, x2: int, y2: int, button: Button = "left", duration: float = 0.4) -> None:
    pyautogui.moveTo(x1, y1, duration=0.15)
    pyautogui.dragTo(x2, y2, duration=duration, button=button)
    _log("mouse_drag", x1=x1, y1=y1, x2=x2, y2=y2, button=button)


def mouse_scroll(amount: int, x: int | None = None, y: int | None = None) -> None:
    """Positive = scroll up, negative = scroll down. `amount` is clicks."""
    if x is not None and y is not None:
        pyautogui.moveTo(x, y, duration=0.1)
    pyautogui.scroll(amount)
    _log("mouse_scroll", amount=amount, x=x, y=y)


def mouse_position() -> tuple[int, int]:
    x, y = pyautogui.position()
    return int(x), int(y)


# ─────────────────────────────────────────────────────────────────────────────
# Keyboard
# ─────────────────────────────────────────────────────────────────────────────

def type_text(text: str, interval: float = 0.02) -> None:
    pyautogui.typewrite(text, interval=interval)
    _log("type_text", text=text)


def key_press(key: str) -> None:
    """Single key: 'enter', 'tab', 'escape', 'f5', 'a', etc."""
    pyautogui.press(key)
    _log("key_press", key=key)


def key_combo(keys: list[str]) -> None:
    """Chord like ['ctrl', 'c'] or ['alt', 'tab'] or ['win', 'r']."""
    pyautogui.hotkey(*keys)
    _log("key_combo", keys=keys)


def key_down(key: str) -> None:
    pyautogui.keyDown(key)
    _log("key_down", key=key)


def key_up(key: str) -> None:
    pyautogui.keyUp(key)
    _log("key_up", key=key)


# ─────────────────────────────────────────────────────────────────────────────
# App launch & window control (Windows)
# ─────────────────────────────────────────────────────────────────────────────

# Friendly aliases → executables. Extend as needed.
APP_ALIASES: dict[str, str] = {
    "notepad": "notepad.exe",
    "calculator": "calc.exe",
    "calc": "calc.exe",
    "explorer": "explorer.exe",
    "files": "explorer.exe",
    "cmd": "cmd.exe",
    "powershell": "powershell.exe",
    "edge": "msedge.exe",
    "chrome": "chrome.exe",
    "firefox": "firefox.exe",
    "paint": "mspaint.exe",
    "snippingtool": "SnippingTool.exe",
    "settings": "ms-settings:",
    "blender": "blender.exe",
    "rhino": "Rhino.exe",
    "comfyui": None,  # user must provide path
}


def launch_app(name_or_path: str, args: list[str] | None = None, wait_seconds: float = 1.5) -> dict[str, Any]:
    """Launch an application by alias, executable name (resolved via PATH), or absolute path.

    Returns {"ok": bool, "pid": int|None, "command": str, "error": str|None}.
    """
    args = args or []
    key = name_or_path.strip().lower()
    target = APP_ALIASES.get(key, name_or_path)
    if target is None:
        return {"ok": False, "pid": None, "command": name_or_path, "error": f"No path mapping for alias '{name_or_path}'"}

    # Handle ms-settings: and other URI schemes via start
    if target.endswith(":") or "://" in target:
        try:
            subprocess.Popen(["cmd", "/c", "start", "", target], shell=False)
            time.sleep(wait_seconds)
            _log("launch_app", target=target, scheme=True)
            return {"ok": True, "pid": None, "command": target, "error": None}
        except Exception as exc:
            return {"ok": False, "pid": None, "command": target, "error": str(exc)}

    resolved = shutil.which(target) or target
    try:
        proc = subprocess.Popen([resolved, *args], shell=False)
        time.sleep(wait_seconds)
        _log("launch_app", target=resolved, pid=proc.pid, args=args)
        return {"ok": True, "pid": proc.pid, "command": resolved, "error": None}
    except FileNotFoundError as exc:
        return {"ok": False, "pid": None, "command": resolved, "error": f"executable not found: {exc}"}
    except Exception as exc:
        return {"ok": False, "pid": None, "command": resolved, "error": str(exc)}


# ── Windows window enumeration (ctypes, no extra deps) ──

def list_windows() -> list[dict[str, Any]]:
    """Enumerate visible top-level windows with title + handle."""
    if os.name != "nt":
        return []
    user32 = ctypes.windll.user32
    EnumWindows = user32.EnumWindows
    GetWindowTextW = user32.GetWindowTextW
    GetWindowTextLengthW = user32.GetWindowTextLengthW
    IsWindowVisible = user32.IsWindowVisible

    EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    results: list[dict[str, Any]] = []

    def _callback(hwnd, _lparam):
        if not IsWindowVisible(hwnd):
            return True
        length = GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        GetWindowTextW(hwnd, buf, length + 1)
        results.append({"hwnd": int(hwnd), "title": buf.value})
        return True

    EnumWindows(EnumWindowsProc(_callback), 0)
    return results


def focus_window(title_substring: str) -> dict[str, Any]:
    """Bring the first visible window whose title contains `title_substring` to the foreground."""
    if os.name != "nt":
        return {"ok": False, "error": "focus_window: Windows only"}
    needle = title_substring.lower()
    for win in list_windows():
        if needle in win["title"].lower():
            user32 = ctypes.windll.user32
            user32.ShowWindow(win["hwnd"], 9)  # SW_RESTORE
            ok = bool(user32.SetForegroundWindow(win["hwnd"]))
            _log("focus_window", hwnd=win["hwnd"], title=win["title"], ok=ok)
            return {"ok": ok, "hwnd": win["hwnd"], "title": win["title"]}
    return {"ok": False, "error": f"no window with title containing '{title_substring}'"}


# ─────────────────────────────────────────────────────────────────────────────
# Misc
# ─────────────────────────────────────────────────────────────────────────────

def wait(seconds: float) -> None:
    time.sleep(seconds)
    _log("wait", seconds=seconds)


def cursor_position() -> dict[str, int]:
    x, y = mouse_position()
    return {"x": x, "y": y}
