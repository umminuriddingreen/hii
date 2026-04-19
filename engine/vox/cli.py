#!/usr/bin/env python3
"""
VOX CLI — Persistent local voice-to-action engine.

Modes:
    vox                 # single push-to-talk command
    vox live            # persistent always-listening daemon (like Grok voice)
    vox route "text"    # route text directly, skip voice
    vox status          # show vox + HII + hermes status
"""

import argparse
import sys
import time
import signal
import os
from pathlib import Path

# Ensure HII root is on path
ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _print_banner():
    print("""
  ╔══════════════════════════════════════╗
  ║   VOX — Voice Engine for HII        ║
  ║   mlx-whisper → qwen3.6 → HII/Yang  ║
  ║   100% local · M3 Max optimized     ║
  ╚══════════════════════════════════════╝
    """)


def _print_result(route_result: dict, exec_result: dict):
    r = route_result
    status = "✓" if exec_result.get("ok") else "✗"
    print(f"\n  {status}  [{r.get('route','?')}] {r.get('intent','')}")
    if r.get("confidence"):
        print(f"     confidence: {r['confidence']}")
    if r.get("reasoning"):
        print(f"     reason: {r['reasoning']}")
    print(f"\n  ── output ──")
    output = exec_result.get("output", "(no output)")
    for line in output.split("\n")[:30]:
        print(f"  {line}")
    print()


def cmd_single(args):
    """Single push-to-talk command."""
    from .capture import record_push_to_talk
    from .transcribe import transcribe
    from .router import route
    from .executor import execute
    from .speak import speak

    _print_banner()
    print("  Press ENTER to start recording, ENTER again to stop.")
    input()

    audio_path = record_push_to_talk()
    print(f"  ⚡ Transcribing...")

    result = transcribe(audio_path)
    text = result["text"]
    print(f"  📝 \"{text}\" ({result['duration_ms']}ms, {result['engine']})")

    if not text:
        print("  (no speech detected)")
        return

    print(f"  🧠 Routing...")
    routed = route(text)

    print(f"  🚀 Executing via {routed.get('route')}...")
    exec_result = execute(routed)
    _print_result(routed, exec_result)

    # Speak short results
    output = exec_result.get("output", "")
    if len(output) < 300:
        speak(output)


def cmd_live(args):
    """Persistent always-listening mode — like Grok voice but local."""
    from .capture import record_vad
    from .transcribe import transcribe
    from .router import route
    from .executor import execute
    from .speak import speak

    _print_banner()
    print("  🔴 LIVE MODE — always listening (Ctrl+C to exit)")
    print("  Speak naturally. VOX will detect speech and act.\n")

    running = True

    def _stop(sig, frame):
        nonlocal running
        running = False
        print("\n  VOX stopped.")
        sys.exit(0)

    signal.signal(signal.SIGINT, _stop)

    cycle = 0
    while running:
        cycle += 1
        try:
            audio_path = record_vad(
                silence_duration=float(args.silence) if hasattr(args, 'silence') else 1.5,
                silence_threshold=args.threshold if hasattr(args, 'threshold') else "1%",
            )

            result = transcribe(audio_path)
            text = result["text"]

            if not text or len(text.strip()) < 3:
                continue

            print(f"  [{cycle}] 📝 \"{text}\" ({result['duration_ms']}ms)")

            # Wake word filter (optional)
            wake_words = ["hey vox", "vox", "hey yang", "yang"]
            text_lower = text.lower().strip()

            # If wake word used, strip it
            for w in wake_words:
                if text_lower.startswith(w):
                    text = text[len(w):].strip().lstrip(",").strip()
                    break

            if not text or len(text.strip()) < 3:
                speak("Yes?")
                continue

            routed = route(text)
            exec_result = execute(routed)
            _print_result(routed, exec_result)

            output = exec_result.get("output", "")
            if len(output) < 300 and output:
                speak(output)

        except RuntimeError:
            # No speech detected, loop back
            continue
        except Exception as e:
            print(f"  ⚠ Error: {e}")
            time.sleep(1)


def cmd_route(args):
    """Route text directly without voice."""
    from .router import route
    from .executor import execute
    from .speak import speak

    text = " ".join(args.text)
    if not text:
        print("Usage: vox route 'your command here'")
        return

    print(f"  🧠 Routing: \"{text}\"")
    routed = route(text)

    print(f"  🚀 Executing via {routed.get('route')}...")
    exec_result = execute(routed)
    _print_result(routed, exec_result)


def cmd_status(args):
    """Show status of VOX, HII, and Hermes."""
    import subprocess

    print("\n  VOX Status")
    print("  ──────────")

    # Check Ollama
    try:
        r = subprocess.run(["ollama", "list"], capture_output=True, text=True, timeout=5)
        models = [l.split()[0] for l in r.stdout.strip().split("\n")[1:] if l.strip()]
        print(f"  Ollama:  ✓ ({len(models)} models: {', '.join(models[:3])})")
    except Exception:
        print("  Ollama:  ✗ not running")

    # Check whisper
    try:
        import mlx_whisper
        print("  Whisper: ✓ mlx-whisper (M3 Max accelerated)")
    except ImportError:
        print("  Whisper: ○ openai-whisper (CPU fallback)")

    # Check HII
    try:
        r = subprocess.run(
            [sys.executable, "-m", "engine.cli", "daemon", "status"],
            capture_output=True, text=True, cwd=str(ROOT), timeout=5,
        )
        status = "✓ running" if "running" in r.stdout.lower() else "○ stopped"
        print(f"  HII:     {status}")
    except Exception:
        print("  HII:     ○ unknown")

    # Check Hermes (Claude Code)
    try:
        r = subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=5)
        print(f"  Hermes:  ✓ Claude Code {r.stdout.strip()}")
    except Exception:
        print("  Hermes:  ✗ not found")

    # Check sox
    try:
        subprocess.run(["rec", "--version"], capture_output=True, timeout=5)
        print("  Audio:   ✓ sox/rec installed")
    except Exception:
        print("  Audio:   ✗ sox not found (brew install sox)")

    print()


def main():
    parser = argparse.ArgumentParser(prog="vox", description="VOX — Voice-to-Action Engine for HII")
    sub = parser.add_subparsers(dest="mode")

    # live mode
    live_p = sub.add_parser("live", help="Persistent always-listening mode")
    live_p.add_argument("--silence", default="1.5", help="Seconds of silence before stopping")
    live_p.add_argument("--threshold", default="1%", help="Silence threshold")

    # route mode
    route_p = sub.add_parser("route", help="Route text directly")
    route_p.add_argument("text", nargs="+")

    # status
    sub.add_parser("status", help="Show system status")

    args = parser.parse_args()

    if args.mode == "live":
        cmd_live(args)
    elif args.mode == "route":
        cmd_route(args)
    elif args.mode == "status":
        cmd_status(args)
    else:
        cmd_single(args)


if __name__ == "__main__":
    main()
