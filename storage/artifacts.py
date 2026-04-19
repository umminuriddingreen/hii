from __future__ import annotations

import hashlib
import mimetypes
from pathlib import Path
from uuid import uuid4

from hii.paths import HII_ARTIFACTS, ensure_hii_dirs

def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def put_bytes(data: bytes, logical_name: str, suffix: str = "") -> dict:
    ensure_hii_dirs()
    artifact_id = str(uuid4())
    version_id = str(uuid4())
    digest = _sha256_bytes(data)

    shard = digest[:2]
    relpath = Path(shard) / f"{digest}{suffix}"
    abspath = HII_ARTIFACTS / relpath
    abspath.parent.mkdir(parents=True, exist_ok=True)
    abspath.write_bytes(data)

    mime_type = mimetypes.guess_type(str(abspath))[0]

    return {
        "artifact_id": artifact_id,
        "version_id": version_id,
        "storage_relpath": str(relpath),
        "sha256": digest,
        "size_bytes": len(data),
        "mime_type": mime_type,
        "logical_name": logical_name,
    }
