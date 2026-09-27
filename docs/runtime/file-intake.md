# HII local file intake

HII owns model selection and document intake. Surfaces call the installed HII runtime module; they do not keep their own provider catalogs. The native runtime's live `/health` loaded model, checked against `/v1/models`, is the loaded-model authority. Catalog entries alone are not loaded-model proof. Hosted and remote model routes are excluded from file intake.

CLI contract:

```
hii model intake ingest /path/to/file
hii model intake read FILE_ID relevant terms
hii model intake runtime
```

Files and extraction records live privately under `~/.hii/context/attachments/<sha256>/`. IDs bind content and original filename. Source bytes are retained separately from the model prompt. A record contains filename, extraction kind, content size, warnings, source path, timestamp, and a preview/description for images.

Images are detected by magic bytes, not filename. On Mac, `sips` converts supported images, including HEIC masquerading as PNG, to a bounded PNG preview. HII's local vision model creates a separate, bounded description. Main chat consumes the description rather than the image payload. Descriptions are model interpretations and may contain errors; normalized previews remain available.

The Python extractor supports UTF-8 text/code, CSV, JSON, PDF, DOCX, PPTX, XLSX, ODT, and RTF. PDF/RTF use local `pdftotext`/`textutil`. Extraction stops at 200,000 characters, PDFs at 40 pages, spreadsheets at 200 rows per sheet, and archives at 40 selected XML entries. Bounds are reported. Scanned PDFs with no text use a first-page vision preview only, explicitly labeled. Unsupported binaries fail rather than enter the prompt.

Retrieval scores 1,200-character chunks against the current question. Only up to two relevant excerpts per file enter the main request, up to four files and 6,000 aggregate characters. With no matching terms the first chunks are used; this is lexical retrieval, not a claim of whole-document understanding. Recent conversation text is separately capped at 24,000 characters. Attachment excerpts are marked as untrusted source data.

Verification: `node --test runtime/model-runtime/intake.test.mjs`, `python3 -m py_compile runtime/model-runtime/extract.py`, and live image/document intake through the CLI and local page.
