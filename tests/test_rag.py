"""RAG chunk tests."""

from hii.rag.chunk import simple_chunk


def test_simple_chunk_basic():
    text = " ".join(f"word{i}" for i in range(100))
    chunks = simple_chunk(text, target_tokens=50, overlap=10)
    assert len(chunks) >= 2
    assert all(len(c.split()) <= 50 for c in chunks)


def test_simple_chunk_empty():
    assert simple_chunk("") == []


def test_simple_chunk_short():
    chunks = simple_chunk("hello world", target_tokens=900)
    assert len(chunks) == 1
    assert chunks[0] == "hello world"
