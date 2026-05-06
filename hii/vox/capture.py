"""
Audio capture using sox (rec).
Hold-to-talk: press Enter to start, Enter to stop.
VAD mode: silence-based auto-stop.
"""

import subprocess
import tempfile
import os
import sys
import signal
import threading
from pathlib import Path

SAMPLE_RATE = 16000
CHANNELS = 1
AUDIO_DIR = Path(tempfile.gettempdir()) / "vox_audio"


def _ensure_dir():
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)


def record_push_to_talk() -> str:
    """Record until user presses Enter. Returns path to wav file."""
    _ensure_dir()
    outpath = str(AUDIO_DIR / "vox_recording.wav")

    print("\n  🎙  Recording... press ENTER to stop\n")

    proc = subprocess.Popen(
        ["rec", "-q", "-r", str(SAMPLE_RATE), "-c", str(CHANNELS), "-b", "16", outpath],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    input()  # block until Enter
    proc.terminate()
    proc.wait()

    if not os.path.exists(outpath) or os.path.getsize(outpath) < 1000:
        raise RuntimeError("Recording too short or failed")

    return outpath


def record_vad(silence_duration: float = 1.5, silence_threshold: str = "1%") -> str:
    """Record with voice activity detection — stops after silence."""
    _ensure_dir()
    outpath = str(AUDIO_DIR / "vox_recording.wav")

    print("\n  🎙  Listening... speak now (auto-stops after silence)\n")

    proc = subprocess.Popen(
        [
            "rec", "-q", "-r", str(SAMPLE_RATE), "-c", str(CHANNELS), "-b", "16",
            outpath,
            "silence", "1", "0.1", "3%",   # start on voice
            "1", str(silence_duration), silence_threshold,  # stop on silence
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    proc.wait()

    if not os.path.exists(outpath) or os.path.getsize(outpath) < 1000:
        raise RuntimeError("No speech detected")

    return outpath
