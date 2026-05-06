"""File ingest pipeline."""

from __future__ import annotations
from pathlib import Path
from .chunk import simple_chunk
from .vectordb import VectorStore, DocChunk

TEXT_EXTS = {".md", ".txt", ".js", ".ts", ".tsx", ".jsx", ".py", ".go",
             ".rs", ".java", ".json", ".yaml", ".yml", ".toml", ".sh"}
SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "dist", "target"}


def collect_files(root: Path) -> list[Path]:
    results = []
    for p in root.rglob("*"):
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        if p.is_file() and p.suffix.lower() in TEXT_EXTS:
            results.append(p)
    return results


def ingest_path(db: VectorStore, embed_fn, root: str) -> int:
    """Ingest all text files under root. embed_fn(texts) -> embeddings."""
    files = collect_files(Path(root))
    count = 0
    for f in files:
        text = f.read_text(errors="replace")
        chunks = simple_chunk(text)
        if not chunks:
            continue
        embeddings = embed_fn(chunks)
        doc_chunks = [
            DocChunk(id=f"{f}#{i}", doc_id=str(f), path=str(f),
                     content=c, embedding=embeddings[i])
            for i, c in enumerate(chunks)
        ]
        db.upsert(doc_chunks)
        count += len(doc_chunks)
    return count
