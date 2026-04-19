"""
VOX — Voice-to-Action Engine for HII

Local voice command system powered by:
- mlx-whisper (M3 Max optimized transcription)
- Ollama qwen3.6:35b (intent routing)
- HII engine (skills, tasks, agents)
- Claude Code / Hermes (architect-level tasks)

Usage:
    vox              # hold-to-talk, single command
    vox listen       # continuous listening mode
    vox route "..."  # route text intent directly (skip voice)
    vox status       # show engine status
"""

__version__ = "0.1.0"
