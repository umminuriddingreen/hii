#!/usr/bin/env python3
"""Dependency-light, one-shot extraction worker for HII Context Dock."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1
MAX_OUTPUT_BYTES = 20_000_000


def response(status: str, **fields: Any) -> dict[str, Any]:
    return {"protocolVersion": PROTOCOL_VERSION, "status": status, **fields}


def extract_pdf(request: dict[str, Any]) -> dict[str, Any]:
    supplied = request.get("path")
    if not isinstance(supplied, str) or not supplied.strip():
        return response("error", code="invalid_request", message="PDF extraction requires a path.")
    source = Path(supplied).expanduser()
    if not source.is_file():
        return response("error", code="source_unreadable", message="PDF source is not a readable file.")

    extractor = shutil.which("pdftotext")
    if extractor is None:
        return response(
            "unavailable",
            code="pdf_text_extractor_unavailable",
            message="pdftotext is not installed or is not on PATH.",
            capability="pdf_text",
        )

    try:
        completed = subprocess.run(
            [extractor, "-enc", "UTF-8", "-eol", "unix", str(source), "-"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return response("error", code="extractor_timeout", message="pdftotext exceeded the 30 second limit.")
    except OSError as error:
        return response("error", code="extractor_failed", message=f"Could not start pdftotext: {error}")

    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()[:500]
        return response("error", code="extractor_failed", message=detail or "pdftotext failed.")
    if len(completed.stdout) > MAX_OUTPUT_BYTES:
        return response("error", code="output_too_large", message="Extracted PDF text exceeds the 20 MB limit.")

    text = completed.stdout.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    raw_pages = text.split("\f")
    if raw_pages and not raw_pages[-1].strip():
        raw_pages.pop()
    pages = [{"page": index + 1, "text": page.rstrip("\n")} for index, page in enumerate(raw_pages)]
    if not any(page["text"].strip() for page in pages):
        return response(
            "unavailable",
            code="pdf_ocr_unavailable",
            message="The PDF has no extractable text and OCR is not configured.",
            capability="pdf_ocr",
        )
    version = None
    try:
        version_result = subprocess.run(
            [extractor, "-v"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, timeout=5, check=False,
        )
        if version_result.stdout:
            version = version_result.stdout.decode("utf-8", errors="replace").splitlines()[0][:200]
    except (OSError, subprocess.TimeoutExpired):
        pass
    return response(
        "ok",
        capability="pdf_text",
        extractor={"name": "pdftotext", "path": extractor, "version": version},
        pages=pages,
    )


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        json.dump(response("error", code="invalid_json", message=str(error)), sys.stdout, separators=(",", ":"))
        return 0
    if not isinstance(request, dict) or request.get("protocolVersion") != PROTOCOL_VERSION:
        result = response("error", code="unsupported_protocol", message="Expected protocolVersion 1.")
    elif request.get("operation") == "extract_pdf":
        result = extract_pdf(request)
    else:
        result = response("error", code="unsupported_operation", message="Unsupported extraction operation.")
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
