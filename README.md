# hii — Local Agentic CLI (Ollama + RAG + Web + Memory)

hii is an offline‑first, local agentic CLI that runs on your Mac, powered by Ollama models. It can search your files (RAG), do web/academic lookups, optionally run shell commands, and log/recall chats to an Obsidian vault for durable memory.

## Quick Start

- Prereqs: Node 20+, Ollama running; pull models:
  - `ollama pull qwen2.5:32b`
  - `ollama pull deepseek-coder-v2:16b`
  - `ollama pull nomic-embed-text`
- Install/build:
  - `cd cli && npm install && npm run build && npm link`
- Ingest your files: `hii ingest --path ./workspace`
- Ask with RAG: `hii chat "search files for auth middleware and explain"`
- Web search: `export SERPAPI_KEY=... && hii chat --web "web: compare vector DBs"`
- Scholarly: `hii chat --web --scholarly "papers on QLoRA for small GPUs"`
- Memory (Obsidian): enabled by default → see “Obsidian Memory”.

## Commands

- `hii ingest --path <folder>`: Index text/code files into local LanceDB
- `hii chat [flags] "prompt"`:
  - `--shell`: allow shell execution (dangerous; use sparingly)
  - `--web`: enable web search (SerpAPI/DuckDuckGo)
  - `--web-provider serpapi|duckduckgo`: pick provider
  - `--scholarly`: academic mode (arXiv/OpenAlex/Crossref)
  - `--download-pdfs`: fetch OA PDFs and ingest into RAG
  - `--no-memory`: disable Obsidian memory for this call
  - `--memory-entries <n>`: recall this many entries
- `hii papers "query" [--max N]`: Fetch OA PDFs for a query and ingest
- `hii models [--set-base <m>] [--set-coder <m>] [--set-embed <m>]`
- `hii models --set-vault "/Users/ummi/Library/Mobile Documents/iCloud~md~obsidian/Documents/hii/hii"`
- `hii models --set-memory on --set-memory-entries 30`
- `hii config`: print effective config
- `hii tool new <name>`: scaffold a new tool file
 - `hii memory test [--vault <path>]`: write a test entry to the vault

## Configuration

- File: `agent.config.json` in the project root (auto‑created if you save settings via `hii models`).
- Env:
  - `OLLAMA_URL`: default `http://127.0.0.1:11434`
  - `SERPAPI_KEY`: enable Google results via SerpAPI
  - `HII_OBSIDIAN_VAULT`: override Obsidian vault path
- Defaults (see `src/config.ts`):
  - Base: `qwen2.5:32b`, Coder: `deepseek-coder-v2:16b`, Embed: `nomic-embed-text`
  - DB path: `./data`, Workspace: `./workspace`, Sessions: `./sessions`
  - Memory: enabled, max 20 entries

## RAG (Local Files)

- Ingest: `hii ingest --path ./workspace`
- Supported types: `.md .txt .js/.ts/.tsx/.jsx .py .go .rs .java .json .yaml/.yml`
- Chunking: ~900 tokens with ~150 overlap (word‑approximate)

## Web & Academic Search

- Web providers:
  - SerpAPI (needs `SERPAPI_KEY`) → high quality, Google
  - DuckDuckGo HTML (no key) → free fallback, conservative scraping
- Academic:
  - Sources: arXiv (API), OpenAlex, Crossref
  - Flags: `--scholarly`, optionally `--download-pdfs`
  - PDF ingest: OA PDFs are downloaded (<= 25 MB) → parsed → added to RAG

## Obsidian Memory (Human + AI Augmentation)

- Default vault: `/Users/ummi/Library/Mobile Documents/iCloud~md~obsidian/Documents/hii/hii`
- What it does:
  - Recalls last N chat entries as context to improve continuity
  - Logs each chat to `Chats/YYYY-MM-DD.md`
- Controls:
  - Disable per call: `--no-memory`
  - Size: `--memory-entries <n>` or set in config
  - Change vault via `HII_OBSIDIAN_VAULT` or `agent.config.json`
  - Set vault via CLI: `hii models --set-vault "<path>"`
  - Test write: `hii memory test`
- Best Practices (see `docs/obsidian.md`): tags, templates, backlinks/MOCs, periodic reviews

## Safety

- Shell is off by default; enable with `--shell`. Prefer read‑only commands; add confirmations for destructive actions in future.
- Web: enable explicitly (`--web`).
- PDF size capped at 25 MB; limited fetch count per call.

## Troubleshooting

- `ollama serve` must be running; ensure pulled models exist
- If `hii` not found after `npm link`, ensure your global npm bin is in PATH
- LanceDB files appear under `./data`; delete to reset index
- Obsidian vault path must be accessible; the CLI will create `Chats/` on first log

## License

Private repository by request; no license header added.
