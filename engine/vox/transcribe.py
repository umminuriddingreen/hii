"""
Transcription using mlx-whisper — optimized for Apple Silicon M3 Max.
Falls back to openai-whisper if mlx unavailable.
"""

import time

MLX_MODEL = "mlx-community/whisper-large-v3-turbo"


def transcribe(audio_path: str, language: str = "en") -> dict:
    """Transcribe audio file. Returns {"text": str, "duration_ms": int, "engine": str}."""
    start = time.time()

    try:
        import mlx_whisper
        result = mlx_whisper.transcribe(
            audio_path,
            path_or_hf_repo=MLX_MODEL,
            language=language,
        )
        engine = "mlx-whisper"
    except ImportError:
        import subprocess, json
        proc = subprocess.run(
            ["whisper", audio_path, "--model", "large-v3", "--language", language,
             "--output_format", "json", "--output_dir", "/tmp/vox_whisper"],
            capture_output=True, text=True,
        )
        import pathlib
        json_out = list(pathlib.Path("/tmp/vox_whisper").glob("*.json"))
        if json_out:
            with open(json_out[-1]) as f:
                result = json.load(f)
        else:
            result = {"text": ""}
        engine = "openai-whisper"

    elapsed = int((time.time() - start) * 1000)
    text = result.get("text", "").strip()

    return {"text": text, "duration_ms": elapsed, "engine": engine}
