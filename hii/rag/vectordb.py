"""LanceDB vector store."""

from __future__ import annotations
from dataclasses import dataclass
from typing import Any
import lancedb


@dataclass
class DocChunk:
    id: str
    doc_id: str
    path: str
    content: str
    embedding: list[float]
    meta: dict[str, Any] | None = None


class VectorStore:
    TABLE = "chunks"

    def __init__(self, db_path: str):
        self.db = lancedb.connect(db_path)
        self._table = None

    def _get_table(self):
        if self._table is None:
            names = self.db.table_names()
            if self.TABLE in names:
                self._table = self.db.open_table(self.TABLE)
            else:
                self._table = self.db.create_table(self.TABLE, schema={
                    "id": "string", "doc_id": "string", "path": "string",
                    "content": "string", "embedding": "vector[384]",
                })
        return self._table

    def upsert(self, chunks: list[DocChunk]):
        table = self._get_table()
        rows = [{"id": c.id, "doc_id": c.doc_id, "path": c.path,
                 "content": c.content, "embedding": c.embedding} for c in chunks]
        table.add(rows)

    def search(self, query_embedding: list[float], k: int = 5) -> list[dict]:
        table = self._get_table()
        return table.search(query_embedding).limit(k).to_list()
