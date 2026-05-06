"""Text chunking for RAG ingest."""


def simple_chunk(text: str, target_tokens: int = 900, overlap: int = 150) -> list[str]:
    words = text.split()
    chunks = []
    i = 0
    while i < len(words):
        end = min(i + target_tokens, len(words))
        chunks.append(" ".join(words[i:end]))
        i = max(end - overlap, end)
    return [c for c in chunks if c]
