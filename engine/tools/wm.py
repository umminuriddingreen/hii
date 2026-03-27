#!/usr/bin/env python3
"""
HII Window Manager — Controls AeroSpace layouts via shell commands.

Binds HII skills to window arrangements for real-time concurrency.
Uses `aerospace` CLI and `osascript` for app launching.

Layouts:
- assignment: ComfyUI (left) + Rhino (right) + Terminal (bottom)
- dashboard: Browser (HII dashboard) + Terminal side by side
- research:  Browser + Obsidian + Terminal
- build:     VS Code/Cursor + Terminal
- present:   Full screen browser or presentation app
"""

import subprocess
import time
import sys


def run(cmd: str):
    subprocess.run(cmd, shell=True, capture_output=True)


def open_app(name: str):
    """Open a macOS app by name."""
    run(f'open -a "{name}"')


def aerospace(cmd: str):
    """Run an AeroSpace CLI command."""
    run(f'aerospace {cmd}')


def layout_assignment():
    """
    Assignment layout: ComfyUI browser + Rhino + Terminal
    For doing ARCH483 image-to-3D work.
    """
    print("Setting up assignment layout...")

    # Open apps
    open_app("Google Chrome")
    time.sleep(1)
    open_app("Rhinoceros")
    time.sleep(1)
    open_app("Terminal")
    time.sleep(0.5)

    # Use aerospace to arrange
    # Move to workspace A for assignment
    aerospace("workspace A")
    time.sleep(0.5)

    # Set horizontal tiling
    aerospace("layout tiles horizontal")

    print("Assignment layout ready: Chrome (ComfyUI) | Rhino | Terminal")
    print("Open http://127.0.0.1:8188 in Chrome for ComfyUI")


def layout_dashboard():
    """Dashboard layout: HII dashboard + Terminal."""
    print("Setting up dashboard layout...")

    open_app("Google Chrome")
    time.sleep(0.5)
    # Open HII dashboard
    run('open http://127.0.0.1:8888')
    time.sleep(0.5)
    open_app("Terminal")

    aerospace("workspace D")
    aerospace("layout tiles horizontal")

    print("Dashboard layout ready: HII Dashboard | Terminal")


def layout_research():
    """Research layout: Browser + Obsidian + Terminal."""
    print("Setting up research layout...")

    open_app("Google Chrome")
    time.sleep(0.5)
    open_app("Obsidian")
    time.sleep(0.5)
    open_app("Terminal")

    aerospace("workspace R")
    aerospace("layout tiles horizontal")

    print("Research layout ready: Browser | Obsidian | Terminal")


def layout_build():
    """Build layout: Editor + Terminal."""
    print("Setting up build layout...")

    # Try Cursor first, fall back to VS Code
    open_app("Cursor")
    time.sleep(0.5)
    open_app("Terminal")

    aerospace("workspace B")
    aerospace("layout tiles horizontal")

    print("Build layout ready: Editor | Terminal")


def layout_present():
    """Presentation layout: Full screen app."""
    print("Setting up presentation layout...")
    aerospace("workspace P")
    aerospace("layout floating")
    print("Presentation layout ready (floating mode)")


def layout_comfyui_pipeline():
    """
    Full ComfyUI pipeline layout for the assignment:
    Left: ComfyUI (generation)
    Right top: File browser (chain folders)
    Right bottom: Terminal (running scripts)
    """
    print("Setting up ComfyUI pipeline layout...")

    run('open http://127.0.0.1:8188')
    time.sleep(1)
    run('open ~/rhino-integration/chains/')
    time.sleep(0.5)
    open_app("Terminal")

    aerospace("workspace C")
    aerospace("layout tiles horizontal")

    print("ComfyUI pipeline ready")
    print("  Left: ComfyUI at http://127.0.0.1:8188")
    print("  Right: Chain folders + Terminal")


LAYOUTS = {
    "assignment": layout_assignment,
    "dashboard": layout_dashboard,
    "research": layout_research,
    "build": layout_build,
    "present": layout_present,
    "comfyui": layout_comfyui_pipeline,
}


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in LAYOUTS:
        print(f"Usage: python wm.py <{'|'.join(LAYOUTS.keys())}>")
        print("\nLayouts:")
        for name, fn in LAYOUTS.items():
            print(f"  {name}: {fn.__doc__.strip().split(chr(10))[0]}")
        sys.exit(1)

    LAYOUTS[sys.argv[1]]()
