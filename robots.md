# hii — Local Agentic CLI

This document tracks the design, codebase overview, build notes, features, and planned work for `hii`, an offline-first local agentic CLI powered by Ollama.

## Overview

- Goal: Provide a local CLI that can chat, run tools, perform RAG over files, and optionally use web search — all offline-first with models served by Ollama.
- Platform: macOS (M3 Max), Node.js TypeScript.
- Models (Ollama):
  - Base/Reasoner: `qwen2.5:32b` (configurable)
  - Coder: `deepseek-coder-v2:16b` (configurable)
  - Embeddings: `nomic-embed-text`

## Project Structure

```
cli/
  src/
    agent.ts             # Agent loop; routes to tools; calls Ollama chat
    cli.ts               # CLI entry (bin: `hii`)
    clients/ollama.ts    # Chat + embeddings client for Ollama
    config.ts            # Load/save config (models, paths, flags)
    rag/
      chunk.ts           # Simple text chunker
      ingest.ts          # Ingests files, embeds, upserts into vector store
    store/vectordb.ts    # LanceDB vector store wrapper
    tools/
      rag.ts             # RAG search tool
      shell.ts           # Shell execution tool
      search.ts          # Web search placeholder
  package.json           # Name `hii`, bin -> dist/cli.js
  tsconfig.json          # ESM TS config
  .gitignore             # Node, dist, data, sessions
  robots.md              # This document
```

## How It Works

1. Ingest: `hii ingest --path ./workspace`
   - Recursively finds text/code files.
   - Chunks text (approx 900 tokens, 150 overlap).
   - Creates embeddings via Ollama `nomic-embed-text`.
   - Upserts to LanceDB at `data/`.

2. Chat: `hii chat "your prompt" [--shell] [--web]`
   - Builds a minimal system prompt and user message.
   - Heuristic tool triggers:
     - RAG: prompt contains "search files", "rag", or "lookup".
     - Shell: `--shell` flag and prompt starts with `run` or contains `shell:`.
     - Web: `--web` flag and prompt contains "search web" or `web:`.
   - Tool outputs (if any) are added as a `tool` role message.
   - Sends messages to Ollama `chat` with the configured base model.

3. Config/Models:
   - `hii config` prints current config.
   - `hii models` shows/set base/coder/embed models.

## Code Notes

- ESM modules (TypeScript with `moduleResolution: bundler`).
- Ollama client hits `/api/chat` and `/api/embeddings` on `http://127.0.0.1:11434` (configurable via `OLLAMA_URL`).
- Vector store uses LanceDB; table `chunks` is lazily created.
- Chunker is simple word-based; can be replaced with token-aware logic.

## Build & Run

- Prereqs: Node 20+, Ollama running, pulled models (`qwen2.5:32b`, `deepseek-coder-v2:16b`, `nomic-embed-text`).
- Install: `npm install && npm run build`
- Link globally: `npm link` to expose `hii` on PATH.

## Current Features

- Chat with local LLM via Ollama.
- RAG over local files (text/code) via LanceDB.
- Optional shell execution tool (`--shell`).
- Web search placeholder (disabled/offline default).
- Configurable models and flags; local JSON persisted.

## Limitations / TODOs

- Tool-calling: heuristic; no structured function-call loop yet.
- Web search: no real provider; add SerpAPI or local scraping.
- Filetypes: PDF/DOCX/CSV not yet supported.
- Guardrails: no interactive confirmations for destructive shell actions.
- REPL: `chat` is single-turn; add multi-turn interactive mode.
- Tests: none yet.

## Planned Roadmap

1. Structured Tool-Calling
   - Define tool schema (rag.search, shell.run, web.search).
   - Implement controller loop: model suggests tool calls -> execute -> feed results -> final answer.

2. Web Search Provider
   - SerpAPI integration via `SERPAPI_KEY` env and `--web` flag.
   - Option: headless browser for scraping with rate limiting.

3. RAG Enhancements
   - PDF via `pdf-parse`, DOCX via `docx`, CSV parsing.
   - Hybrid retrieval (BM25 + vector) and metadata filters.
   - Smarter chunking for code (by function/class) and markdown sections.

4. Safety & UX
   - Shell confirmations for write/destructive commands.
   - Dry-run patches for file edits.
   - Sandboxed working directory and allowlist.

5. Developer Experience
   - Interactive REPL (`hii chat` without args).
   - Session logs and resume.
   - Optional React TUI.

## Release Notes

- v0.1.0 (initial scaffold)
  - CLI commands: `ingest`, `chat`, `models`, `config`.
  - Ollama chat + embeddings.
  - LanceDB vector store.
  - Basic tools: RAG search, shell, web stub.

