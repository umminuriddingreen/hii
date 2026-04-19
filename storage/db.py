from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from hii.paths import HII_DB, ensure_hii_dirs

def connect(db_path: Path | None = None) -> sqlite3.Connection:
    ensure_hii_dirs()
    path = str(db_path or HII_DB)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA temp_store=MEMORY;")
    return conn

@contextmanager
def transaction(conn: sqlite3.Connection):
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
