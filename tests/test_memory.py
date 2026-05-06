"""Memory tests."""

from hii.memory import MemoryEntry, format_for_context


def test_format_for_context():
    entries = [
        MemoryEntry(ts="2026-04-19T10:00:00", prompt="hello", answer="hi", tools=[]),
        MemoryEntry(ts="2026-04-19T10:01:00", prompt="test", answer="ok", tools=["web_search"]),
    ]
    result = format_for_context(entries)
    assert "hello" in result
    assert "hi" in result
    assert "test" in result
