"""Config tests."""

from hii.config import Config


def test_defaults():
    cfg = Config()
    assert cfg.chat_backend == "ollama"
    assert cfg.offline is True
    assert cfg.allow_shell is False


def test_load_creates_config():
    cfg = Config.load()
    assert cfg.chat_backend in ("ollama", "claude", "lmstudio", "mlx", "codex")
    assert cfg.embed_model
