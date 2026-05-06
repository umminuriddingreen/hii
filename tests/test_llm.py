"""LLM client tests."""

from hii.llm import get_client, ChatMessage
from hii.llm.ollama import OllamaClient


def test_get_client_ollama():
    client = get_client("ollama")
    assert isinstance(client, OllamaClient)


def test_get_client_default():
    client = get_client("unknown")
    assert isinstance(client, OllamaClient)


def test_chat_message():
    msg = ChatMessage(role="user", content="hello")
    assert msg.role == "user"
    assert msg.content == "hello"
