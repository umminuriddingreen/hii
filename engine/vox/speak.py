"""
Text-to-speech output using macOS `say` command.
Fast, local, zero-latency.
"""

import subprocess
import threading


def speak(text: str, voice: str = "Samantha", rate: int = 210, block: bool = False):
    """Speak text aloud using macOS TTS."""
    # Truncate very long outputs
    if len(text) > 500:
        text = text[:500] + "... truncated."

    cmd = ["say", "-v", voice, "-r", str(rate), text]

    if block:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        threading.Thread(
            target=subprocess.run, args=(cmd,),
            kwargs={"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL},
            daemon=True,
        ).start()
