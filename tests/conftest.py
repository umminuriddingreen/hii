"""Shared test fixtures."""

import pytest
from hii.config import Config


@pytest.fixture
def config():
    return Config(
        chat_backend="ollama",
        base_model="test-model",
        embed_model="nomic-embed-text",
        allow_shell=False,
        allow_search=False,
        offline=True,
    )
